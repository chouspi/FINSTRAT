using System.Text.Json;

namespace Finstrat.Api.Modules.MarketData;

public sealed class VwcePriceService(IHttpClientFactory httpClientFactory)
{
    private static readonly TimeSpan MinimumRefreshInterval = TimeSpan.FromMinutes(1);
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private VwcePrice? _lastKnown;

    public async Task<VwcePrice> GetAsync(CancellationToken cancellationToken)
    {
        if (IsFresh(_lastKnown)) return _lastKnown!;

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            if (IsFresh(_lastKnown)) return _lastKnown!;

            try
            {
                var client = httpClientFactory.CreateClient("vwce-price");
                var vwceTask = client.GetAsync("v8/finance/chart/VWCE.AS?interval=1d&range=1d", cancellationToken);
                var fxTask = client.GetAsync("v8/finance/chart/EURCZK=X?interval=1d&range=1d", cancellationToken);
                await Task.WhenAll(vwceTask, fxTask);
                using var vwceResponse = await vwceTask;
                using var fxResponse = await fxTask;
                vwceResponse.EnsureSuccessStatusCode();
                fxResponse.EnsureSuccessStatusCode();

                var priceEur = await ReadMarketPriceAsync(vwceResponse, cancellationToken);
                var eurCzk = await ReadMarketPriceAsync(fxResponse, cancellationToken);
                if (priceEur <= 0 || eurCzk <= 0)
                    throw new InvalidOperationException("Price provider returned an invalid VWCE price.");

                _lastKnown = new VwcePrice(
                    priceEur,
                    decimal.Round(priceEur * eurCzk, 4),
                    DateTimeOffset.UtcNow,
                    "yahoo-finance",
                    false);
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

    private static async Task<decimal> ReadMarketPriceAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var payload = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return payload.RootElement
            .GetProperty("chart")
            .GetProperty("result")[0]
            .GetProperty("meta")
            .GetProperty("regularMarketPrice")
            .GetDecimal();
    }

    private static bool IsFresh(VwcePrice? price) =>
        price is not null && DateTimeOffset.UtcNow - price.ObservedAt < MinimumRefreshInterval;
}

public sealed record VwcePrice(
    decimal PriceEur,
    decimal PriceCzk,
    DateTimeOffset ObservedAt,
    string Source,
    bool IsStale);
