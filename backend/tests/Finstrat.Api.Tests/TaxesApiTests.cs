using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class TaxesApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Taxable_recommendation_can_be_deferred_and_income_purchase_consumes_planned_amount()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var userName = $"taxes-{Guid.NewGuid():N}";
        var token = await GetAntiforgeryToken(client);
        using (var createUser = new HttpRequestMessage(HttpMethod.Post, "/api/identity/users")
        {
            Content = JsonContent.Create(new { userName, displayName = "Taxes Owner", email = (string?)null, password = "Sample324", role = "owner" }),
        })
        {
            createUser.Headers.Add("X-CSRF-TOKEN", token);
            Assert.Equal(HttpStatusCode.Created, (await client.SendAsync(createUser)).StatusCode);
        }

        token = await GetAntiforgeryToken(client);
        using (var login = new HttpRequestMessage(HttpMethod.Post, "/api/identity/login")
        {
            Content = JsonContent.Create(new { identifier = userName, password = "Sample324" }),
        })
        {
            login.Headers.Add("X-CSRF-TOKEN", token);
            Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(login)).StatusCode);
        }

        var btcAccountId = Guid.NewGuid();
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var setup = new NpgsqlCommand("""
                WITH context AS (
                  SELECT member.household_id, app_user.id AS user_id
                  FROM users app_user JOIN household_members member ON member.user_id=app_user.id
                  WHERE app_user.user_name=@user_name
                ), account AS (
                  INSERT INTO btc_accounts (id,household_id,owner_user_id,name)
                  SELECT @account_id,household_id,user_id,@account_name FROM context
                ), lot AS (
                  INSERT INTO btc_lots (household_id,account_id,quantity_btc,unit_price_czk,acquired_at,tax_acquired_at,created_at,created_by)
                  SELECT household_id,@account_id,0.10000000,1000000,now(),now(),now()-interval '1 day',user_id FROM context
                )
                INSERT INTO btc_strategy_states (household_id,owner_user_id,checkpoint_base_czk,activated_at)
                SELECT household_id,user_id,100000,now()-interval '1 hour' FROM context;
                """, connection);
            setup.Parameters.AddWithValue("user_name", userName);
            setup.Parameters.AddWithValue("account_id", btcAccountId);
            setup.Parameters.AddWithValue("account_name", $"Taxable BTC {Guid.NewGuid():N}");
            await setup.ExecuteNonQueryAsync();
        }

        var taxes = await client.GetFromJsonAsync<JsonElement>("/api/taxes/overview");
        Assert.Equal(0.1m, taxes.GetProperty("taxableBtc").GetDecimal());
        Assert.Equal(0m, taxes.GetProperty("taxFreeBtc").GetDecimal());
        Assert.Equal(100000m, taxes.GetProperty("recommendedTransferCzk").GetDecimal());
        Assert.True(taxes.GetProperty("canDeferRecommendedTransfer").GetBoolean());

        token = await GetAntiforgeryToken(client);
        var deferKey = Guid.NewGuid();
        var deferred = await SendDeferred(client, token, deferKey);
        var deferredReplay = await SendDeferred(client, token, deferKey);
        Assert.Equal(HttpStatusCode.Created, deferred.StatusCode);
        Assert.Equal(HttpStatusCode.Created, deferredReplay.StatusCode);
        var deferredBody = await deferred.Content.ReadFromJsonAsync<JsonElement>();
        var deferredReplayBody = await deferredReplay.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(deferredBody.GetProperty("id").GetGuid(), deferredReplayBody.GetProperty("id").GetGuid());
        Assert.Equal(100000m, deferredBody.GetProperty("deferredVwceCzk").GetDecimal());

        var strategy = await client.GetFromJsonAsync<JsonElement>("/api/strategy/overview");
        Assert.Equal(200000m, strategy.GetProperty("checkpointValueCzk").GetDecimal());
        var income = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(100000m, income.GetProperty("deferredVwceCzk").GetDecimal());

        token = await GetAntiforgeryToken(client);
        using var createAccount = new HttpRequestMessage(HttpMethod.Post, "/api/vwce/accounts")
        {
            Content = JsonContent.Create(new { name = $"Income VWCE {Guid.NewGuid():N}", description = (string?)null }),
        };
        createAccount.Headers.Add("X-CSRF-TOKEN", token);
        var accountResponse = await client.SendAsync(createAccount);
        Assert.Equal(HttpStatusCode.Created, accountResponse.StatusCode);
        var vwceAccountId = (await accountResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        token = await GetAntiforgeryToken(client);
        var purchaseKey = Guid.NewGuid();
        var purchaseBody = new
        {
            shares = "0.00100000",
            unitPriceCzk = "100.00",
            acquiredAt = DateTimeOffset.UtcNow.ToString("O"),
            note = "Income plan",
            consumeDeferredVwce = true,
            deferredVwceAmountCzk = "2000.00",
        };
        var purchase = await SendPurchase(client, vwceAccountId, token, purchaseKey, purchaseBody);
        var purchaseReplay = await SendPurchase(client, vwceAccountId, token, purchaseKey, purchaseBody);
        Assert.Equal(HttpStatusCode.Created, purchase.StatusCode);
        var purchasePayload = await purchase.Content.ReadFromJsonAsync<JsonElement>();
        var replayPayload = await purchaseReplay.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(purchasePayload.GetProperty("id").GetGuid(), replayPayload.GetProperty("id").GetGuid());
        Assert.Equal(2000m, purchasePayload.GetProperty("deferredVwceConsumedCzk").GetDecimal());
        Assert.Equal(98000m, purchasePayload.GetProperty("deferredVwceRemainingCzk").GetDecimal());

        token = await GetAntiforgeryToken(client);
        var regularPurchase = await SendPurchase(client, vwceAccountId, token, Guid.NewGuid(), new
        {
            shares = "1.00000000",
            unitPriceCzk = "4000.00",
            acquiredAt = DateTimeOffset.UtcNow.ToString("O"),
            note = "Regular purchase",
        });
        Assert.Equal(HttpStatusCode.Created, regularPurchase.StatusCode);
        Assert.Equal(0m, (await regularPurchase.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("deferredVwceConsumedCzk").GetDecimal());

        taxes = await client.GetFromJsonAsync<JsonElement>("/api/taxes/overview");
        Assert.Equal(98000m, taxes.GetProperty("deferredVwceCzk").GetDecimal());
        var movements = await client.GetFromJsonAsync<JsonElement>($"/api/vwce/accounts/{vwceAccountId}/movements");
        var linkedMovement = movements.EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == purchasePayload.GetProperty("id").GetGuid());
        Assert.False(linkedMovement.GetProperty("canEdit").GetBoolean());
        Assert.False(linkedMovement.GetProperty("canDelete").GetBoolean());
    }

    private static async Task<string> GetAntiforgeryToken(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;

    private static Task<HttpResponseMessage> SendDeferred(HttpClient client, string token, Guid key)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/taxes/deferred-vwce") { Content = JsonContent.Create(new { note = "Waiting for time test" }) };
        request.Headers.Add("X-CSRF-TOKEN", token);
        request.Headers.Add("Idempotency-Key", key.ToString());
        return client.SendAsync(request);
    }

    private static Task<HttpResponseMessage> SendPurchase(HttpClient client, Guid accountId, string token, Guid key, object body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/vwce/accounts/{accountId}/purchases") { Content = JsonContent.Create(body) };
        request.Headers.Add("X-CSRF-TOKEN", token);
        request.Headers.Add("Idempotency-Key", key.ToString());
        return client.SendAsync(request);
    }
}
