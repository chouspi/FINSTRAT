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
                var client = httpClientFactory.CreateClient("btc-price");
                var statsTask = client.GetAsync("products/BTC-USD/stats", cancellationToken);
                var czkTask = client.GetAsync("https://api.coinbase.com/v2/prices/BTC-CZK/spot", cancellationToken);
                await Task.WhenAll(statsTask, czkTask);
                using var statsResponse = await statsTask;
                using var czkResponse = await czkTask;
                statsResponse.EnsureSuccessStatusCode();
                czkResponse.EnsureSuccessStatusCode();
                await using var statsStream = await statsResponse.Content.ReadAsStreamAsync(cancellationToken);
                await using var czkStream = await czkResponse.Content.ReadAsStreamAsync(cancellationToken);
                using var statsPayload = await JsonDocument.ParseAsync(statsStream, cancellationToken: cancellationToken);
                using var czkPayload = await JsonDocument.ParseAsync(czkStream, cancellationToken: cancellationToken);
                var lastValue = statsPayload.RootElement.GetProperty("last").GetString();
                var openValue = statsPayload.RootElement.GetProperty("open").GetString();
                var czkValue = czkPayload.RootElement.GetProperty("data").GetProperty("amount").GetString();
                if (!decimal.TryParse(lastValue, NumberStyles.Number, CultureInfo.InvariantCulture, out var price)
                    || !decimal.TryParse(openValue, NumberStyles.Number, CultureInfo.InvariantCulture, out var open)
                    || !decimal.TryParse(czkValue, NumberStyles.Number, CultureInfo.InvariantCulture, out var priceCzk)
                    || price <= 0
                    || open <= 0
                    || priceCzk <= 0)
                {
                    throw new InvalidOperationException("Price provider returned an invalid BTC price.");
                }

                var change24hPercent = decimal.Round((price - open) / open * 100, 4);
                _lastKnown = new BtcPrice(price, priceCzk, change24hPercent, DateTimeOffset.UtcNow, "coinbase", false);
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
    decimal PriceCzk,
    decimal Change24hPercent,
    DateTimeOffset ObservedAt,
    string Source,
    bool IsStale);
