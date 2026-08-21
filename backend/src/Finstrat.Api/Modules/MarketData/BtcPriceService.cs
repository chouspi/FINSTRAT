using System.Globalization;
using System.Text.Json;

namespace Finstrat.Api.Modules.MarketData;

public sealed class BtcPriceService(IHttpClientFactory httpClientFactory)
{
    private static readonly TimeSpan MinimumRefreshInterval = TimeSpan.FromSeconds(4);
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private BtcPrice? _lastKnown;

    public async Task<BtcPrice> GetAsync(CancellationToken cancellationToken)
    {
        if (IsFresh(_lastKnown)) return _lastKnown!;

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            if (IsFresh(_lastKnown)) return _lastKnown!;

            try
            {
                using var response = await httpClientFactory.CreateClient("btc-price")
                    .GetAsync("products/BTC-USD/stats", cancellationToken);
                response.EnsureSuccessStatusCode();
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
                using var payload = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
                var lastValue = payload.RootElement.GetProperty("last").GetString();
                var openValue = payload.RootElement.GetProperty("open").GetString();
                if (!decimal.TryParse(lastValue, NumberStyles.Number, CultureInfo.InvariantCulture, out var price)
                    || !decimal.TryParse(openValue, NumberStyles.Number, CultureInfo.InvariantCulture, out var open)
                    || price <= 0
                    || open <= 0)
                {
                    throw new InvalidOperationException("Price provider returned an invalid BTC price.");
                }

                var change24hPercent = decimal.Round((price - open) / open * 100, 4);
                _lastKnown = new BtcPrice(price, change24hPercent, DateTimeOffset.UtcNow, "coinbase", false);
                return _lastKnown;
            }
            catch (Exception exception) when (
                (exception is HttpRequestException or JsonException or InvalidOperationException or TaskCanceledException)
                && !cancellationToken.IsCancellationRequested
                && _lastKnown is not null)
            {
                return _lastKnown with { IsStale = true };
            }
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private static bool IsFresh(BtcPrice? price) =>
        price is not null && DateTimeOffset.UtcNow - price.ObservedAt < MinimumRefreshInterval;
}

public sealed record BtcPrice(
    decimal PriceUsd,
    decimal Change24hPercent,
    DateTimeOffset ObservedAt,
    string Source,
    bool IsStale);
