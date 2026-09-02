using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class IncomePlanApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Settings_are_user_scoped_validated_and_persisted()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(90m, overview.GetProperty("settings").GetProperty("withoutDebtBtcPercent").GetDecimal());

        var token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/income-plan/settings")
        {
            Content = JsonContent.Create(new
            {
                defaultCapitalCzk = "42000.00", withoutDebtBtcPercent = 85,
                withoutDebtCashPercent = 15, withDebtBtcPercent = 60,
                withDebtDebtPercent = 25, withDebtCashPercent = 15,
            }),
        };
        request.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(request)).StatusCode);

        overview = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(42000m, overview.GetProperty("settings").GetProperty("defaultCapitalCzk").GetDecimal());
        Assert.Equal(25m, overview.GetProperty("settings").GetProperty("withDebtDebtPercent").GetDecimal());

        token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        var invalid = new HttpRequestMessage(HttpMethod.Put, "/api/income-plan/settings")
        {
            Content = JsonContent.Create(new
            {
                defaultCapitalCzk = "1000", withoutDebtBtcPercent = 80,
                withoutDebtCashPercent = 10, withDebtBtcPercent = 60,
                withDebtDebtPercent = 25, withDebtCashPercent = 15,
            }),
        };
        invalid.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(invalid)).StatusCode);
    }

    [Fact]
    public async Task Deferred_debt_payment_is_accumulated_and_consumed_safely()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;

        async Task<HttpResponseMessage> Adjust(string path, string amount, string expected)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, path)
            {
                Content = JsonContent.Create(new { amountCzk = amount, expectedDeferredDebtPaymentCzk = expected }),
            };
            request.Headers.Add("X-CSRF-TOKEN", token);
            return await client.SendAsync(request);
        }

        Assert.Equal(HttpStatusCode.OK, (await Adjust("/api/income-plan/deferred-debt-payment", "2000.00", "0.00")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Adjust("/api/income-plan/deferred-debt-payment", "2000.00", "0.00")).StatusCode);
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(2000m, overview.GetProperty("settings").GetProperty("deferredDebtPaymentCzk").GetDecimal());

        Assert.Equal(HttpStatusCode.OK, (await Adjust("/api/income-plan/deferred-debt-payment/consume", "500.00", "2000.00")).StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(1500m, overview.GetProperty("settings").GetProperty("deferredDebtPaymentCzk").GetDecimal());

        var delete = new HttpRequestMessage(HttpMethod.Delete,
            "/api/income-plan/deferred-debt-payment?expectedDeferredDebtPaymentCzk=1500.00");
        delete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(0m, overview.GetProperty("settings").GetProperty("deferredDebtPaymentCzk").GetDecimal());
    }
}
