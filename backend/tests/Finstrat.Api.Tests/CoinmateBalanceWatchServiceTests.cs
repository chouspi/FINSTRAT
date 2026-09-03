using System.Net;
using System.Text;
using System.Text.Json;
using Finstrat.Api.Modules.IncomePlan;
using Microsoft.Extensions.Configuration;

namespace Finstrat.Api.Tests;

public sealed class CoinmateBalanceWatchServiceTests
{
    [Fact]
    public async Task Start_sends_bearer_auth_and_maps_controller_response()
    {
        var handler = new StubHandler(HttpStatusCode.OK,
            """{"watch_id":"44bd4f6f-7e2f-47d1-99d4-380184dd08d4","currency":"CZK","initial_balance":123.45,"expires_in_seconds":60}""");
        var service = CreateService(handler, "test-token");

        var result = await service.StartAsync(CancellationToken.None);

        Assert.Equal(HttpMethod.Post, handler.Method);
        Assert.Equal("https://controller.test/root/balance_watch/czk", handler.RequestUri?.ToString());
        Assert.Equal("Bearer", handler.AuthorizationScheme);
        Assert.Equal("test-token", handler.AuthorizationParameter);
        Assert.Equal(Guid.Parse("44bd4f6f-7e2f-47d1-99d4-380184dd08d4"), result.WatchId);
        Assert.Equal("CZK", result.Currency);
        Assert.Equal(123.45m, result.InitialBalance);
        Assert.Equal(60d, result.ExpiresInSeconds);
    }

    [Fact]
    public async Task Watch_maps_controller_response()
    {
        var handler = new StubHandler(HttpStatusCode.OK,
            """{"changed":true,"currency":"CZK","balance":456.78}""");
        var service = CreateService(handler, "test-token");
        var watchId = Guid.NewGuid();

        var result = await service.WatchAsync(watchId, CancellationToken.None);

        Assert.Equal(HttpMethod.Get, handler.Method);
        Assert.EndsWith($"/balance_watch/{watchId:D}", handler.RequestUri?.AbsolutePath);
        Assert.True(result.Changed);
        Assert.Equal("CZK", result.Currency);
        Assert.Equal(456.78m, result.Balance);
    }

    [Fact]
    public async Task Missing_token_is_unavailable_without_sending_request()
    {
        var handler = new StubHandler(HttpStatusCode.OK, "{}");
        var service = CreateService(handler, null);

        await Assert.ThrowsAsync<CoinmateBalanceWatchUnavailableException>(
            () => service.StartAsync(CancellationToken.None));
        Assert.Equal(0, handler.RequestCount);
    }

    [Fact]
    public async Task Upstream_not_found_is_preserved()
    {
        var service = CreateService(new StubHandler(HttpStatusCode.NotFound, ""), "test-token");

        await Assert.ThrowsAsync<CoinmateBalanceWatchNotFoundException>(
            () => service.WatchAsync(Guid.NewGuid(), CancellationToken.None));
    }

    [Fact]
    public async Task Purchase_sends_numeric_amount_auth_and_idempotency_and_maps_response()
    {
        var handler = new StubHandler(HttpStatusCode.Accepted,
            """{"success":true,"btc_bought":0.00123,"status":"submitted","pending":true}""");
        var service = CreateService(handler, "test-token");
        var idempotencyKey = Guid.NewGuid();

        var result = await service.PurchaseBitcoinAsync(1234.50m, idempotencyKey, CancellationToken.None);

        Assert.Equal(HttpMethod.Post, handler.Method);
        Assert.Equal("https://controller.test/root/buy_bitcoin", handler.RequestUri?.ToString());
        Assert.Equal("Bearer", handler.AuthorizationScheme);
        Assert.Equal("test-token", handler.AuthorizationParameter);
        Assert.Equal(idempotencyKey.ToString("D"), handler.IdempotencyKey);
        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal(JsonValueKind.Number, body.RootElement.GetProperty("amount").ValueKind);
        Assert.Equal(1234.50m, body.RootElement.GetProperty("amount").GetDecimal());
        Assert.True(result.Success);
        Assert.Equal(0.00123m, result.BtcBought);
        Assert.Equal("submitted", result.Status);
        Assert.True(result.Pending);
    }

    [Fact]
    public async Task Purchase_status_get_maps_snake_case_response()
    {
        var handler = new StubHandler(HttpStatusCode.OK,
            """{"success":true,"btc_bought":0.00456,"status":"completed","pending":false}""");
        var service = CreateService(handler, "test-token");
        var idempotencyKey = Guid.NewGuid();

        var result = await service.GetBitcoinPurchaseAsync(idempotencyKey, CancellationToken.None);

        Assert.Equal(HttpMethod.Get, handler.Method);
        Assert.Equal($"https://controller.test/root/buy_bitcoin/{idempotencyKey:D}", handler.RequestUri?.ToString());
        Assert.Null(handler.IdempotencyKey);
        Assert.True(result.Success);
        Assert.Equal(0.00456m, result.BtcBought);
        Assert.Equal("completed", result.Status);
        Assert.False(result.Pending);
    }

    private static CoinmateBalanceWatchService CreateService(StubHandler handler, string? token)
    {
        var values = new Dictionary<string, string?>
        {
            ["CoinmateController:BaseUrl"] = "https://controller.test/root/",
            ["CoinmateController:ApiToken"] = token,
        };
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        return new CoinmateBalanceWatchService(new StubHttpClientFactory(handler), configuration);
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, false)
        {
            Timeout = TimeSpan.FromSeconds(45),
        };
    }

    private sealed class StubHandler(HttpStatusCode statusCode, string body) : HttpMessageHandler
    {
        public int RequestCount { get; private set; }
        public HttpMethod? Method { get; private set; }
        public Uri? RequestUri { get; private set; }
        public string? AuthorizationScheme { get; private set; }
        public string? AuthorizationParameter { get; private set; }
        public string? IdempotencyKey { get; private set; }
        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestCount++;
            Method = request.Method;
            RequestUri = request.RequestUri;
            AuthorizationScheme = request.Headers.Authorization?.Scheme;
            AuthorizationParameter = request.Headers.Authorization?.Parameter;
            IdempotencyKey = request.Headers.TryGetValues("Idempotency-Key", out var values)
                ? Assert.Single(values)
                : null;
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(statusCode)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        }
    }
}
