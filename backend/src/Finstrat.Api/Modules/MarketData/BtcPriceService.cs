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
                    .GetAsync("v2/prices/BTC-USD/spot", cancellationToken);
                response.EnsureSuccessStatusCode();
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
                using var payload = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
                var amount = payload.RootElement.GetProperty("data").GetProperty("amount").GetString();
                if (!decimal.TryParse(amount, NumberStyles.Number, CultureInfo.InvariantCulture, out var price) || price <= 0)
                {
                    throw new InvalidOperationException("Price provider returned an invalid BTC price.");
                }

                _lastKnown = new BtcPrice(price, DateTimeOffset.UtcNow, "coinbase", false);
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

public sealed record BtcPrice(decimal PriceUsd, DateTimeOffset ObservedAt, string Source, bool IsStale);
