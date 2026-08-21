using System.Text.Json;

namespace Finstrat.Api.Modules.MarketData;

public static class MarketDataEndpoints
{
    public static IEndpointRouteBuilder MapMarketDataEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/market-data/btc-price", async (
            BtcPriceService priceService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await priceService.GetAsync(cancellationToken));
            }
            catch (Exception exception) when (
                (exception is HttpRequestException or JsonException or InvalidOperationException or TaskCanceledException)
                && !cancellationToken.IsCancellationRequested)
            {
                return Results.Problem(
                    statusCode: StatusCodes.Status503ServiceUnavailable,
                    title: "BTC price is temporarily unavailable");
            }
        })
        .WithTags("Market Data")
        .RequireAuthorization();

        return endpoints;
    }
}
