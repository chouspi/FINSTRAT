using System.Net;
using Finstrat.Api.Modules.MarketData;

namespace Finstrat.Api.Tests;

public sealed class VwcePriceServiceTests
{
    [Fact]
    public async Task Converts_yahoo_eur_price_to_czk_and_caches_the_result()
    {
        var handler = new StubHandler();
        var service = new VwcePriceService(new StubHttpClientFactory(handler));

        var first = await service.GetAsync(CancellationToken.None);
        var second = await service.GetAsync(CancellationToken.None);

        Assert.Equal(165.79m, first.PriceEur);
        Assert.Equal(3998.8548m, first.PriceCzk);
        Assert.Equal("yahoo-finance", first.Source);
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
            var price = request.RequestUri?.AbsolutePath.Contains("EURCZK") == true ? "24.1200" : "165.79";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"chart\":{\"result\":[{\"meta\":{\"regularMarketPrice\":" + price + "}}]}}"),
            });
        }
    }
}
