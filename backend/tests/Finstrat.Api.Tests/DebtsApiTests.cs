using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class DebtsApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Debt_ledger_supports_idempotent_payments_payoff_and_archive()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await Token(client);
        var created = await Send(client, HttpMethod.Post, "/api/debts", token, new
        {
            name = $"Consumer loan {Guid.NewGuid():N}", openingBalanceCzk = "100000.00",
            priority = 5, isMortgage = false, openedAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = "Integration",
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var debtId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        token = await Token(client);
        var updated = await Send(client, HttpMethod.Put, $"/api/debts/{debtId}", token, new
        {
            name = "Updated consumer loan", priority = 1, isMortgage = false, note = "Managed",
        });
        Assert.Equal(HttpStatusCode.NoContent, updated.StatusCode);
        var managedOverview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        var managedDebt = managedOverview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(1, managedDebt.GetProperty("priority").GetInt16());
        Assert.Equal("Updated consumer loan", managedDebt.GetProperty("name").GetString());

        token = await Token(client);
        var drawdownKey = Guid.NewGuid();
        var drawdownBody = new { amountCzk = "25000.00", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = "Additional borrowing" };
        var drawdown = await SendDrawdown(client, debtId, token, drawdownKey, drawdownBody);
        var drawdownReplay = await SendDrawdown(client, debtId, token, drawdownKey, drawdownBody);
        Assert.Equal(HttpStatusCode.Created, drawdown.StatusCode);
        Assert.Equal(125000m, (await drawdown.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("balanceCzk").GetDecimal());
        Assert.Equal(125000m, (await drawdownReplay.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("balanceCzk").GetDecimal());

        token = await Token(client);
        var key = Guid.NewGuid();
        var paymentBody = new { amountCzk = "30000.00", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = "Partial" };
        var first = await SendPayment(client, debtId, token, key, paymentBody);
        var replay = await SendPayment(client, debtId, token, key, paymentBody);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(95000m, (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("balanceCzk").GetDecimal());
        Assert.Equal(95000m, (await replay.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("balanceCzk").GetDecimal());

        token = await Token(client);
        var overpayment = await SendPayment(client, debtId, token, Guid.NewGuid(), new
        {
            amountCzk = "95000.01", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = (string?)null,
        });
        Assert.Equal(HttpStatusCode.BadRequest, overpayment.StatusCode);

        token = await Token(client);
        var payoff = await SendPayment(client, debtId, token, Guid.NewGuid(), new
        {
            amountCzk = "95000.00", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = "Payoff",
        });
        Assert.Equal(HttpStatusCode.Created, payoff.StatusCode);
        Assert.Equal(0m, (await payoff.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("balanceCzk").GetDecimal());

        var entries = await client.GetFromJsonAsync<JsonElement>($"/api/debts/{debtId}/entries");
        Assert.Equal(4, entries.GetArrayLength());
        Assert.Contains(entries.EnumerateArray(), entry => entry.GetProperty("type").GetString() == "drawdown" && entry.GetProperty("amountCzk").GetDecimal() == 25000m);
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        var debt = overview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(0m, debt.GetProperty("balanceCzk").GetDecimal());
        Assert.False(debt.GetProperty("closedAt").ValueKind == JsonValueKind.Null);

        token = await Token(client);
        using var archive = new HttpRequestMessage(HttpMethod.Post, $"/api/debts/{debtId}/archive");
        archive.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(archive)).StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        Assert.DoesNotContain(overview.GetProperty("debts").EnumerateArray(), item => item.GetProperty("id").GetGuid() == debtId);

        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync();
        await using var count = new NpgsqlCommand("SELECT COUNT(*) FROM debt_entries WHERE debt_id = @id", connection);
        count.Parameters.AddWithValue("id", debtId);
        Assert.Equal(4, (long)(await count.ExecuteScalarAsync())!);
    }

    [Fact]
    public async Task Overview_separates_mortgage_and_repayable_balances()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await Token(client);
        await Send(client, HttpMethod.Post, "/api/debts", token, new
        {
            name = $"Mortgage {Guid.NewGuid():N}", openingBalanceCzk = "2500000", priority = 3,
            isMortgage = true, openedAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = (string?)null,
        });
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        Assert.True(overview.GetProperty("totals").GetProperty("mortgageBalanceCzk").GetDecimal() >= 2500000m);
    }

    [Fact]
    public async Task Owner_can_delete_a_payment_and_reopen_a_paid_off_debt()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await Token(client);
        var created = await Send(client, HttpMethod.Post, "/api/debts", token, new
        {
            name = $"Reopen debt {Guid.NewGuid():N}", openingBalanceCzk = "1000.00",
            priority = 4, isMortgage = false, openedAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = (string?)null,
        });
        var debtId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        token = await Token(client);
        await SendPayment(client, debtId, token, Guid.NewGuid(), new
        {
            amountCzk = "1000.00", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = "Paid",
        });
        var entries = await client.GetFromJsonAsync<JsonElement>($"/api/debts/{debtId}/entries");
        var paymentId = entries.EnumerateArray().Single(entry => entry.GetProperty("type").GetString() == "payment").GetProperty("id").GetGuid();

        token = await Token(client);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/debts/{debtId}/payments/{paymentId}");
        delete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        var debt = overview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(1000m, debt.GetProperty("balanceCzk").GetDecimal());
        Assert.Equal(JsonValueKind.Null, debt.GetProperty("closedAt").ValueKind);
        entries = await client.GetFromJsonAsync<JsonElement>($"/api/debts/{debtId}/entries");
        Assert.Single(entries.EnumerateArray());
    }

    [Fact]
    public async Task Future_payment_is_reserved_until_it_becomes_due_and_is_confirmed()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await Token(client);
        var created = await Send(client, HttpMethod.Post, "/api/debts", token, new
        {
            name = $"Scheduled debt {Guid.NewGuid():N}", openingBalanceCzk = "10000.00",
            priority = 5, isMortgage = false, openedAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = (string?)null,
        });
        var debtId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        token = await Token(client);
        var scheduled = await SendPayment(client, debtId, token, Guid.NewGuid(), new
        {
            amountCzk = "5000.00", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(7).ToString("O"), note = "Future",
        });
        Assert.True(scheduled.StatusCode == HttpStatusCode.Created, await scheduled.Content.ReadAsStringAsync());
        Assert.Equal(10000m, (await scheduled.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("balanceCzk").GetDecimal());

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        var debt = overview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(10000m, debt.GetProperty("balanceCzk").GetDecimal());
        Assert.Equal(5000m, debt.GetProperty("scheduledPaymentCzk").GetDecimal());
        var payment = overview.GetProperty("scheduledPayments").EnumerateArray().Single(item => item.GetProperty("debtId").GetGuid() == debtId);
        Assert.False(payment.GetProperty("isDue").GetBoolean());

        var income = await client.GetFromJsonAsync<JsonElement>("/api/income-plan/overview");
        Assert.True(income.GetProperty("scheduledDebtPaymentCzk").GetDecimal() >= 5000m);

        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var makeDue = new NpgsqlCommand("UPDATE debt_entries SET effective_at = CURRENT_DATE - 1 WHERE id = @id", connection);
            makeDue.Parameters.AddWithValue("id", payment.GetProperty("id").GetGuid());
            await makeDue.ExecuteNonQueryAsync();
        }

        overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        payment = overview.GetProperty("scheduledPayments").EnumerateArray().Single(item => item.GetProperty("debtId").GetGuid() == debtId);
        Assert.True(payment.GetProperty("isDue").GetBoolean());

        token = await Token(client);
        using var confirm = new HttpRequestMessage(HttpMethod.Post, "/api/debts/scheduled-payments/due/confirm");
        confirm.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(confirm)).StatusCode);

        overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        debt = overview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(5000m, debt.GetProperty("balanceCzk").GetDecimal());
        Assert.Equal(0m, debt.GetProperty("scheduledPaymentCzk").GetDecimal());
        Assert.DoesNotContain(overview.GetProperty("scheduledPayments").EnumerateArray(), item => item.GetProperty("debtId").GetGuid() == debtId);

        token = await Token(client);
        scheduled = await SendPayment(client, debtId, token, Guid.NewGuid(), new
        {
            amountCzk = "1000.00", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).AddMonths(1).ToString("O"), note = "Pay early",
        });
        Assert.Equal(HttpStatusCode.Created, scheduled.StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        payment = overview.GetProperty("scheduledPayments").EnumerateArray().Single(item => item.GetProperty("debtId").GetGuid() == debtId);
        token = await Token(client);
        using var confirmEarly = new HttpRequestMessage(HttpMethod.Post,
            $"/api/debts/scheduled-payments/{payment.GetProperty("id").GetGuid()}/confirm");
        confirmEarly.Headers.Add("X-CSRF-TOKEN", token);
        var confirmedEarly = await client.SendAsync(confirmEarly);
        Assert.Equal(HttpStatusCode.OK, confirmedEarly.StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        debt = overview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(4000m, debt.GetProperty("balanceCzk").GetDecimal());
    }

    [Fact]
    public async Task Future_payment_can_reserve_the_entire_remaining_balance()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await Token(client);
        var created = await Send(client, HttpMethod.Post, "/api/debts", token, new
        {
            name = $"Full scheduled debt {Guid.NewGuid():N}", openingBalanceCzk = "2418.82",
            priority = 5, isMortgage = false, openedAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = (string?)null,
        });
        var debtId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        token = await Token(client);
        var scheduled = await SendPayment(client, debtId, token, Guid.NewGuid(), new
        {
            amountCzk = "2418.82", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(2).ToString("O"), note = "Full reservation",
        });

        Assert.True(scheduled.StatusCode == HttpStatusCode.Created, await scheduled.Content.ReadAsStringAsync());
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        var debt = overview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(2418.82m, debt.GetProperty("scheduledPaymentCzk").GetDecimal());
        var paymentId = overview.GetProperty("scheduledPayments").EnumerateArray().Single(item => item.GetProperty("debtId").GetGuid() == debtId).GetProperty("id").GetGuid();

        token = await Token(client);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/debts/{debtId}/payments/{paymentId}");
        delete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        debt = overview.GetProperty("debts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == debtId);
        Assert.Equal(0m, debt.GetProperty("scheduledPaymentCzk").GetDecimal());
    }

    [Fact]
    public async Task Debts_are_visible_and_mutable_only_by_their_owner()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await Token(client);
        var created = await Send(client, HttpMethod.Post, "/api/debts", token, new
        {
            name = $"Private debt {Guid.NewGuid():N}", openingBalanceCzk = "1000.00",
            priority = 2, isMortgage = false, openedAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = (string?)null,
        });
        var debtId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("""
                WITH context AS (
                  SELECT household.id AS household_id
                  FROM households household
                  JOIN household_members member ON member.household_id = household.id
                  JOIN users default_user ON default_user.id = member.user_id
                  WHERE default_user.is_default
                  LIMIT 1
                ), new_user AS (
                  INSERT INTO users (
                    id, user_name, normalized_user_name, display_name, security_stamp, concurrency_stamp
                  ) VALUES (
                    @user_id, @user_name, upper(@user_name), 'Other debt owner',
                    gen_random_uuid()::text, gen_random_uuid()::text
                  ) RETURNING id
                ), membership AS (
                  INSERT INTO household_members (household_id, user_id, role)
                  SELECT context.household_id, new_user.id, 'editor' FROM context, new_user
                )
                UPDATE debts SET owner_user_id = @user_id WHERE id = @debt_id
                """, connection);
            command.Parameters.AddWithValue("user_id", Guid.NewGuid());
            command.Parameters.AddWithValue("user_name", $"debt-owner-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("debt_id", debtId);
            await command.ExecuteNonQueryAsync();
        }

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/debts/overview");
        Assert.DoesNotContain(overview.GetProperty("debts").EnumerateArray(), debt => debt.GetProperty("id").GetGuid() == debtId);
        Assert.Empty((await client.GetFromJsonAsync<JsonElement>($"/api/debts/{debtId}/entries")).EnumerateArray());

        token = await Token(client);
        var update = await Send(client, HttpMethod.Put, $"/api/debts/{debtId}", token, new
        {
            name = "Unauthorized update", priority = 5, isMortgage = false, note = (string?)null,
        });
        Assert.Equal(HttpStatusCode.BadRequest, update.StatusCode);

        token = await Token(client);
        var payment = await SendPayment(client, debtId, token, Guid.NewGuid(), new
        {
            amountCzk = "100.00", effectiveAt = DateOnly.FromDateTime(DateTime.UtcNow).ToString("O"), note = (string?)null,
        });
        Assert.Equal(HttpStatusCode.BadRequest, payment.StatusCode);
    }

    private static async Task<string> Token(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
    private static Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string path, string token, object body)
    { var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body) }; request.Headers.Add("X-CSRF-TOKEN", token); return client.SendAsync(request); }
    private static Task<HttpResponseMessage> SendPayment(HttpClient client, Guid debtId, string token, Guid key, object body)
    { var request = new HttpRequestMessage(HttpMethod.Post, $"/api/debts/{debtId}/payments") { Content = JsonContent.Create(body) }; request.Headers.Add("X-CSRF-TOKEN", token); request.Headers.Add("Idempotency-Key", key.ToString()); return client.SendAsync(request); }
    private static Task<HttpResponseMessage> SendDrawdown(HttpClient client, Guid debtId, string token, Guid key, object body)
    { var request = new HttpRequestMessage(HttpMethod.Post, $"/api/debts/{debtId}/drawdowns") { Content = JsonContent.Create(body) }; request.Headers.Add("X-CSRF-TOKEN", token); request.Headers.Add("Idempotency-Key", key.ToString()); return client.SendAsync(request); }
}
