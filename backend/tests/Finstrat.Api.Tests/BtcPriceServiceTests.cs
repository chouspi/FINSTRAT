using System.Net;
using Finstrat.Api.Modules.MarketData;

namespace Finstrat.Api.Tests;

public sealed class BtcPriceServiceTests
{
    [Fact]
    public async Task Parses_price_and_reuses_it_during_minimum_refresh_interval()
    {
        var handler = new StubHandler();
        var service = new BtcPriceService(new StubHttpClientFactory(handler));

        var first = await service.GetAsync(CancellationToken.None);
        var second = await service.GetAsync(CancellationToken.None);

        Assert.Equal(123456.78m, first.PriceUsd);
        Assert.Equal(2_750_000.50m, first.PriceCzk);
        Assert.Equal(2.8806m, first.Change24hPercent);
        Assert.Equal("coinbase", first.Source);
        Assert.False(first.IsStale);
        Assert.Equal(first, second);
        Assert.Equal(2, handler.RequestCount);
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, false)
        {
            BaseAddress = new Uri("https://example.test/"),
        };
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        public int RequestCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestCount++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(request.RequestUri?.AbsolutePath.Contains("BTC-CZK") == true
                    ? """{"data":{"amount":"2750000.50","base":"BTC","currency":"CZK"}}"""
                    : """{"open":"120000.00","last":"123456.78"}"""),
            });
        }
    }
}
