using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class IncomePlanApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Settings_persist_normalized_payment_details_and_clear_them_with_whitespace()
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
                cashAccountIban = "  cz65 0800 0000 1920 0014 5399  ",
                coinmateIban = "  cz92 5500 0000 0006 2263 3603  ",
                coinmateVariableSymbol = " 3301195845 ",
                coinmateRecipientMessage = "  SAMUEL   KRATOS\tCOINMATE VKLAD  ",
            }),
        };
        request.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(request)).StatusCode);

        overview = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(42000m, overview.GetProperty("settings").GetProperty("defaultCapitalCzk").GetDecimal());
        Assert.Equal(25m, overview.GetProperty("settings").GetProperty("withDebtDebtPercent").GetDecimal());
        Assert.Equal("CZ6508000000192000145399", overview.GetProperty("settings").GetProperty("cashAccountIban").GetString());
        Assert.Equal("CZ9255000000000622633603", overview.GetProperty("settings").GetProperty("coinmateIban").GetString());
        Assert.Equal("3301195845", overview.GetProperty("settings").GetProperty("coinmateVariableSymbol").GetString());
        Assert.Equal("SAMUEL KRATOS COINMATE VKLAD", overview.GetProperty("settings").GetProperty("coinmateRecipientMessage").GetString());

        token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        var clear = new HttpRequestMessage(HttpMethod.Put, "/api/income-plan/settings")
        {
            Content = JsonContent.Create(new
            {
                defaultCapitalCzk = "1000", withoutDebtBtcPercent = 90,
                withoutDebtCashPercent = 10, withDebtBtcPercent = 60,
                withDebtDebtPercent = 25, withDebtCashPercent = 15,
                cashAccountIban = "   ",
                coinmateIban = "   ",
                coinmateVariableSymbol = "   ",
                coinmateRecipientMessage = "   ",
            }),
        };
        clear.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(clear)).StatusCode);

        overview = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(JsonValueKind.Null, overview.GetProperty("settings").GetProperty("cashAccountIban").ValueKind);
        Assert.Equal(JsonValueKind.Null, overview.GetProperty("settings").GetProperty("coinmateIban").ValueKind);
        Assert.Equal(JsonValueKind.Null, overview.GetProperty("settings").GetProperty("coinmateVariableSymbol").ValueKind);
        Assert.Equal(JsonValueKind.Null, overview.GetProperty("settings").GetProperty("coinmateRecipientMessage").ValueKind);

        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT settings.cash_account_iban, settings.coinmate_iban,
              settings.coinmate_variable_symbol, settings.coinmate_recipient_message
            FROM income_plan_settings settings
            JOIN users app_user ON app_user.id = settings.user_id
            WHERE app_user.is_default
            """, connection);
        await using var reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.True(await reader.IsDBNullAsync(0));
        Assert.True(await reader.IsDBNullAsync(1));
        Assert.True(await reader.IsDBNullAsync(2));
        Assert.True(await reader.IsDBNullAsync(3));
    }

    [Theory]
    [InlineData("CZ6508000000192000145398")]
    [InlineData("SK6508000000192000145399")]
    [InlineData("CZ65-0800-0000-1920-0014-5399")]
    public async Task Settings_reject_invalid_czech_iban(string cashAccountIban)
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await UpdateSettings(client, cashAccountIban);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("CZ9255000000000622633604", "3301195845", "Coinmate deposit")]
    [InlineData("CZ9255000000000622633603", "123 456", "Coinmate deposit")]
    [InlineData("CZ9255000000000622633603", "12345678901", "Coinmate deposit")]
    [InlineData("CZ9255000000000622633603", "12345A", "Coinmate deposit")]
    [InlineData("CZ9255000000000622633603", "12345", "Coinmate\n deposit")]
    [InlineData("CZ9255000000000622633603", "12345", "Coinmate deposit 🚀")]
    public async Task Settings_reject_invalid_coinmate_payment_details(
        string coinmateIban, string coinmateVariableSymbol, string coinmateRecipientMessage)
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await UpdateSettings(client, null, coinmateIban,
            coinmateVariableSymbol, coinmateRecipientMessage);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Settings_reject_coinmate_recipient_message_longer_than_sixty_characters()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await UpdateSettings(client, null, "CZ9255000000000622633603",
            "3301195845", new string('A', 61));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Settings_reject_percentage_profiles_that_do_not_total_one_hundred()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/income-plan/settings")
        {
            Content = JsonContent.Create(new
            {
                defaultCapitalCzk = "1000", withoutDebtBtcPercent = 90,
                withoutDebtCashPercent = 15, withDebtBtcPercent = 60,
                withDebtDebtPercent = 25, withDebtCashPercent = 15,
                cashAccountIban = (string?)null,
            }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await Token(client));

        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Payment_details_are_owner_scoped_within_household()
    {
        using var defaultClient = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        Assert.Equal(HttpStatusCode.OK, (await UpdateSettings(defaultClient,
            "CZ65 0800 0000 1920 0014 5399", "CZ92 5500 0000 0006 2263 3603",
            "3301195845", "DEFAULT COINMATE")).StatusCode);

        var userName = $"income-owner-{Guid.NewGuid():N}";
        var token = await Token(defaultClient);
        using (var createUser = new HttpRequestMessage(HttpMethod.Post, "/api/identity/users")
        {
            Content = JsonContent.Create(new
            {
                userName, displayName = "Income Owner", email = (string?)null,
                password = "Sample324", role = "owner",
            }),
        })
        {
            createUser.Headers.Add("X-CSRF-TOKEN", token);
            Assert.Equal(HttpStatusCode.Created, (await defaultClient.SendAsync(createUser)).StatusCode);
        }

        using var ownerClient = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        token = await Token(ownerClient);
        using (var login = new HttpRequestMessage(HttpMethod.Post, "/api/identity/login")
        {
            Content = JsonContent.Create(new { identifier = userName, password = "Sample324" }),
        })
        {
            login.Headers.Add("X-CSRF-TOKEN", token);
            Assert.Equal(HttpStatusCode.NoContent, (await ownerClient.SendAsync(login)).StatusCode);
        }

        var ownerOverview = await ownerClient.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal(JsonValueKind.Null, ownerOverview.GetProperty("settings").GetProperty("cashAccountIban").ValueKind);
        Assert.Equal(JsonValueKind.Null, ownerOverview.GetProperty("settings").GetProperty("coinmateIban").ValueKind);
        Assert.Equal(JsonValueKind.Null, ownerOverview.GetProperty("settings").GetProperty("coinmateVariableSymbol").ValueKind);
        Assert.Equal(JsonValueKind.Null, ownerOverview.GetProperty("settings").GetProperty("coinmateRecipientMessage").ValueKind);
        Assert.Equal(HttpStatusCode.OK, (await UpdateSettings(ownerClient,
            "CZ28 0600 0000 0001 6854 0115", "CZ65 0800 0000 1920 0014 5399",
            "123456", "OWNER COINMATE")).StatusCode);

        var defaultOverview = await defaultClient.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        ownerOverview = await ownerClient.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.Equal("CZ6508000000192000145399", defaultOverview.GetProperty("settings").GetProperty("cashAccountIban").GetString());
        Assert.Equal("CZ2806000000000168540115", ownerOverview.GetProperty("settings").GetProperty("cashAccountIban").GetString());
        Assert.Equal("CZ9255000000000622633603", defaultOverview.GetProperty("settings").GetProperty("coinmateIban").GetString());
        Assert.Equal("3301195845", defaultOverview.GetProperty("settings").GetProperty("coinmateVariableSymbol").GetString());
        Assert.Equal("DEFAULT COINMATE", defaultOverview.GetProperty("settings").GetProperty("coinmateRecipientMessage").GetString());
        Assert.Equal("CZ6508000000192000145399", ownerOverview.GetProperty("settings").GetProperty("coinmateIban").GetString());
        Assert.Equal("123456", ownerOverview.GetProperty("settings").GetProperty("coinmateVariableSymbol").GetString());
        Assert.Equal("OWNER COINMATE", ownerOverview.GetProperty("settings").GetProperty("coinmateRecipientMessage").GetString());
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

    private static async Task<HttpResponseMessage> UpdateSettings(
        HttpClient client,
        string? cashAccountIban,
        string? coinmateIban = null,
        string? coinmateVariableSymbol = null,
        string? coinmateRecipientMessage = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/income-plan/settings")
        {
            Content = JsonContent.Create(new
            {
                defaultCapitalCzk = "1000", withoutDebtBtcPercent = 90,
                withoutDebtCashPercent = 10, withDebtBtcPercent = 60,
                withDebtDebtPercent = 25, withDebtCashPercent = 15,
                cashAccountIban,
                coinmateIban,
                coinmateVariableSymbol,
                coinmateRecipientMessage,
            }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await Token(client));
        return await client.SendAsync(request);
    }

    private static async Task<string> Token(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
}
