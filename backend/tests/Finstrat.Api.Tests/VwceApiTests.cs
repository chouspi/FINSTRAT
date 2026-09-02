using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class VwceApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Owner_can_create_an_idempotent_purchase_on_a_broker_account()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await GetAntiforgeryToken(client);
        using var createAccount = new HttpRequestMessage(HttpMethod.Post, "/api/vwce/accounts")
        {
            Content = JsonContent.Create(new { name = $"Purchase broker {Guid.NewGuid():N}", description = (string?)null }),
        };
        createAccount.Headers.Add("X-CSRF-TOKEN", token);
        var accountResponse = await client.SendAsync(createAccount);
        var accountId = (await accountResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        token = await GetAntiforgeryToken(client);
        var key = Guid.NewGuid();
        var body = new { shares = "1.25000000", unitPriceCzk = "4000.00", acquiredAt = DateTimeOffset.UtcNow.ToString("O"), note = "DCA" };
        var first = await SendPurchase(client, accountId, token, key, body);
        var replay = await SendPurchase(client, accountId, token, key, body);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, replay.StatusCode);
        var firstPayload = await first.Content.ReadFromJsonAsync<JsonElement>();
        var replayPayload = await replay.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(firstPayload.GetProperty("id").GetGuid(), replayPayload.GetProperty("id").GetGuid());

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/vwce/overview");
        var account = overview.GetProperty("accounts").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == accountId);
        Assert.Equal(1.25m, account.GetProperty("shares").GetDecimal());
        Assert.Equal(5000m, account.GetProperty("costBasisCzk").GetDecimal());
    }

    [Fact]
    public async Task Independent_latest_vwce_purchase_can_be_updated_and_deleted()
    {
        var accountId = Guid.NewGuid();
        var movementId = Guid.NewGuid();
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("""
                WITH context AS (
                  SELECT household.id AS household_id, default_user.id AS user_id
                  FROM households household CROSS JOIN users default_user
                  WHERE default_user.is_default ORDER BY household.created_at LIMIT 1
                ), account AS (
                  INSERT INTO vwce_accounts (id, household_id, owner_user_id, name)
                  SELECT @account_id, household_id, user_id, @name FROM context
                )
                INSERT INTO vwce_lots (id, household_id, account_id, shares, unit_price_czk, acquired_at)
                SELECT @movement_id, household_id, @account_id, 1.00000000, 3000.00, now() FROM context
                """, connection);
            command.Parameters.AddWithValue("account_id", accountId);
            command.Parameters.AddWithValue("movement_id", movementId);
            command.Parameters.AddWithValue("name", $"Editable VWCE {Guid.NewGuid():N}");
            await command.ExecuteNonQueryAsync();
        }
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var movements = await client.GetFromJsonAsync<JsonElement>($"/api/vwce/accounts/{accountId}/movements");
        Assert.True(movements[0].GetProperty("canEdit").GetBoolean());
        var token = await GetAntiforgeryToken(client);
        using var update = new HttpRequestMessage(HttpMethod.Put, $"/api/vwce/movements/{movementId}/purchase")
        {
            Content = JsonContent.Create(new { shares = "2.00000000", unitPriceCzk = "3100", acquiredAt = DateTimeOffset.UtcNow.ToString("O"), note = "Updated" }),
        };
        update.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(update)).StatusCode);
        token = await GetAntiforgeryToken(client);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/vwce/movements/{movementId}/purchase");
        delete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);
        Assert.Empty((await client.GetFromJsonAsync<JsonElement>($"/api/vwce/accounts/{accountId}/movements")).EnumerateArray());
    }

    [Fact]
    public async Task Non_default_owner_can_share_vwce_account_with_default_user()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var userName = $"vwce-sharing-{Guid.NewGuid():N}";
        var token = await GetAntiforgeryToken(client);
        using var createUser = new HttpRequestMessage(HttpMethod.Post, "/api/identity/users")
        {
            Content = JsonContent.Create(new
            {
                userName,
                displayName = "VWCE Sharing Owner",
                email = (string?)null,
                password = "Sample324",
                role = "owner",
            }),
        };
        createUser.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.Created, (await client.SendAsync(createUser)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var login = new HttpRequestMessage(HttpMethod.Post, "/api/identity/login")
        {
            Content = JsonContent.Create(new { identifier = userName, password = "Sample324" }),
        };
        login.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(login)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var createAccount = new HttpRequestMessage(HttpMethod.Post, "/api/vwce/accounts")
        {
            Content = JsonContent.Create(new { name = $"Shared broker {Guid.NewGuid():N}", description = (string?)null }),
        };
        createAccount.Headers.Add("X-CSRF-TOKEN", token);
        var accountResponse = await client.SendAsync(createAccount);
        var accountId = (await accountResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        token = await GetAntiforgeryToken(client);
        using var share = new HttpRequestMessage(HttpMethod.Put, $"/api/vwce/accounts/{accountId}/default-share")
        {
            Content = JsonContent.Create(new { shared = true }),
        };
        share.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(share)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var logout = new HttpRequestMessage(HttpMethod.Post, "/api/identity/logout");
        logout.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(logout)).StatusCode);

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/vwce/overview");
        var account = overview.GetProperty("accounts").EnumerateArray()
            .Single(item => item.GetProperty("id").GetGuid() == accountId);
        Assert.Equal("VWCE Sharing Owner", account.GetProperty("ownerDisplayName").GetString());
        Assert.False(account.GetProperty("isOwnedByCurrentUser").GetBoolean());
        Assert.True(account.GetProperty("canManage").GetBoolean());
        Assert.True(account.GetProperty("isSharedWithDefault").GetBoolean());
    }

    [Fact]
    public async Task Owner_can_create_account_and_payout_rent_with_fifo_and_idempotency()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var token = await GetAntiforgeryToken(client);
        using var create = new HttpRequestMessage(HttpMethod.Post, "/api/vwce/accounts")
        {
            Content = JsonContent.Create(new { name = $"Payout broker {Guid.NewGuid():N}", description = "Integration" }),
        };
        create.Headers.Add("X-CSRF-TOKEN", token);
        var createResponse = await client.SendAsync(create);
        Assert.Equal(HttpStatusCode.Created, createResponse.StatusCode);
        var accountId = (await createResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var lot = new NpgsqlCommand("""
                INSERT INTO vwce_lots (
                  household_id, account_id, shares, unit_price_czk, acquired_at
                )
                SELECT household_id, @account_id, 1.00000000, 3000.00, now() - interval '1 day'
                FROM vwce_accounts WHERE id = @account_id
                """, connection);
            lot.Parameters.AddWithValue("account_id", accountId);
            await lot.ExecuteNonQueryAsync();
        }

        token = await GetAntiforgeryToken(client);
        var idempotencyKey = Guid.NewGuid();
        var body = new
        {
            accountId,
            amountCzk = "1000",
            paidAt = new DateTimeOffset(DateTime.UtcNow.Date.AddHours(23), TimeSpan.Zero).ToString("O"),
            note = (string?)null,
        };
        var first = await SendPayout(client, token, idempotencyKey, body);
        var firstPayload = await first.Content.ReadFromJsonAsync<JsonElement>();
        var second = await SendPayout(client, token, idempotencyKey, body);
        var secondPayload = await second.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(firstPayload.GetProperty("id").GetGuid(), secondPayload.GetProperty("id").GetGuid());
        Assert.Equal(0.25m, firstPayload.GetProperty("shares").GetDecimal());
        Assert.Equal(4000m, firstPayload.GetProperty("unitPriceCzk").GetDecimal());

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/vwce/overview");
        var account = overview.GetProperty("accounts").EnumerateArray()
            .Single(item => item.GetProperty("id").GetGuid() == accountId);
        Assert.Equal(0.75m, account.GetProperty("shares").GetDecimal());
        Assert.Equal(2250m, account.GetProperty("costBasisCzk").GetDecimal());
        var movements = await client.GetFromJsonAsync<JsonElement>($"/api/vwce/accounts/{accountId}/movements");
        Assert.Equal(2, movements.GetArrayLength());
        Assert.Contains(movements.EnumerateArray(), movement =>
            movement.GetProperty("type").GetString() == "rent_payout"
            && movement.GetProperty("shares").GetDecimal() == -0.25m);
        var linkedPurchase = movements.EnumerateArray().Single(movement => movement.GetProperty("type").GetString() == "purchase");
        Assert.False(linkedPurchase.GetProperty("canDelete").GetBoolean());
        token = await GetAntiforgeryToken(client);
        using var forbiddenDelete = new HttpRequestMessage(HttpMethod.Delete, $"/api/vwce/movements/{linkedPurchase.GetProperty("id").GetGuid()}/purchase");
        forbiddenDelete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(forbiddenDelete)).StatusCode);

        await using var verifyConnection = new NpgsqlConnection(fixture.ConnectionString);
        await verifyConnection.OpenAsync();
        await using var verify = new NpgsqlCommand("""
            SELECT
              (SELECT COUNT(*) FROM vwce_disposals WHERE account_id = @account_id),
              (SELECT SUM(allocation.shares) FROM vwce_lot_allocations allocation
               JOIN vwce_disposals disposal ON disposal.id = allocation.disposal_id
               WHERE disposal.account_id = @account_id)
            """, verifyConnection);
        verify.Parameters.AddWithValue("account_id", accountId);
        await using var reader = await verify.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal(1, reader.GetInt64(0));
        Assert.Equal(0.25m, reader.GetDecimal(1));
        await reader.DisposeAsync();

        token = await GetAntiforgeryToken(client);
        using var update = new HttpRequestMessage(HttpMethod.Put, $"/api/vwce/accounts/{accountId}")
        {
            Content = JsonContent.Create(new { name = $"Updated broker {Guid.NewGuid():N}", description = "Updated" }),
        };
        update.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(update)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var archive = new HttpRequestMessage(HttpMethod.Delete, $"/api/vwce/accounts/{accountId}");
        archive.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(archive)).StatusCode);
        var afterArchive = await client.GetFromJsonAsync<JsonElement>("/api/vwce/overview");
        Assert.DoesNotContain(afterArchive.GetProperty("accounts").EnumerateArray(), item =>
            item.GetProperty("id").GetGuid() == accountId);
    }

    [Fact]
    public async Task Overview_is_owner_scoped_and_uses_materialized_fifo_allocations()
    {
        var accountId = Guid.NewGuid();
        var hiddenAccountId = Guid.NewGuid();
        var pricedLotId = Guid.NewGuid();
        var disposalId = Guid.NewGuid();
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("""
                WITH context AS (
                  SELECT household.id AS household_id, default_user.id AS default_user_id
                  FROM households household CROSS JOIN users default_user
                  WHERE default_user.is_default ORDER BY household.created_at LIMIT 1
                ), other_user AS (
                  INSERT INTO users (
                    id, user_name, normalized_user_name, display_name, security_stamp, concurrency_stamp
                  ) VALUES (
                    gen_random_uuid(), @other_name, upper(@other_name), 'Hidden VWCE owner',
                    gen_random_uuid()::text, gen_random_uuid()::text
                  ) RETURNING id
                ), membership AS (
                  INSERT INTO household_members (household_id, user_id, role)
                  SELECT context.household_id, other_user.id, 'owner' FROM context, other_user
                ), rent_settings AS (
                  INSERT INTO btc_strategy_settings (household_id, owner_user_id, vwce_rent_rate_percent)
                  SELECT household_id, default_user_id, 2 FROM context
                  ON CONFLICT (household_id, owner_user_id) DO UPDATE
                  SET vwce_rent_rate_percent = EXCLUDED.vwce_rent_rate_percent
                ), accounts AS (
                  INSERT INTO vwce_accounts (id, household_id, owner_user_id, name)
                  SELECT @account_id, household_id, default_user_id, @account_name FROM context
                  UNION ALL
                  SELECT @hidden_account_id, household_id, other_user.id, @hidden_name FROM context, other_user
                ), priced_lot AS (
                  INSERT INTO vwce_lots (
                    id, household_id, account_id, shares, unit_price_czk, acquired_at
                  )
                  SELECT @priced_lot_id, household_id, @account_id, 2.00000000, 1000.00, now() - interval '2 days'
                  FROM context
                ), unknown_lot AS (
                  INSERT INTO vwce_lots (household_id, account_id, shares, unit_price_czk, acquired_at)
                  SELECT household_id, @account_id, 1.00000000, NULL, now() - interval '1 day' FROM context
                ), disposal AS (
                  INSERT INTO vwce_disposals (
                    id, household_id, account_id, kind, shares, unit_price_czk,
                    proceeds_czk, disposed_at, note
                  )
                  SELECT @disposal_id, household_id, @account_id, 'rent_payout', 0.50000000,
                    1200.00, 600.00, now(), 'Rent payout' FROM context
                )
                INSERT INTO vwce_lot_allocations (
                  household_id, disposal_id, lot_id, shares, cost_basis_czk
                )
                SELECT household_id, @disposal_id, @priced_lot_id, 0.50000000, 500.00 FROM context
                """, connection);
            command.Parameters.AddWithValue("other_name", $"vwce-other-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("account_id", accountId);
            command.Parameters.AddWithValue("hidden_account_id", hiddenAccountId);
            command.Parameters.AddWithValue("priced_lot_id", pricedLotId);
            command.Parameters.AddWithValue("disposal_id", disposalId);
            command.Parameters.AddWithValue("account_name", $"Visible broker {Guid.NewGuid():N}");
            command.Parameters.AddWithValue("hidden_name", $"Hidden broker {Guid.NewGuid():N}");
            await command.ExecuteNonQueryAsync();
        }

        using var client = fixture.CreateClient();
        var response = await client.GetAsync("/api/vwce/overview");
        var payload = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var accounts = payload.GetProperty("accounts").EnumerateArray().ToArray();
        var account = accounts.Single(item => item.GetProperty("id").GetGuid() == accountId);
        Assert.DoesNotContain(accounts, item => item.GetProperty("id").GetGuid() == hiddenAccountId);
        Assert.Equal(2.5m, account.GetProperty("shares").GetDecimal());
        Assert.Equal(1500m, account.GetProperty("costBasisCzk").GetDecimal());
        Assert.False(account.GetProperty("costBasisComplete").GetBoolean());
        Assert.Equal(2m, payload.GetProperty("totals").GetProperty("rentRatePercent").GetDecimal());
        Assert.Contains(payload.GetProperty("recentMovements").EnumerateArray(),
            item => item.GetProperty("id").GetGuid() == disposalId && item.GetProperty("shares").GetDecimal() == -0.5m);
    }

    private static async Task<string> GetAntiforgeryToken(HttpClient client)
    {
        var response = await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery");
        return response.GetProperty("token").GetString()!;
    }

    private static Task<HttpResponseMessage> SendPayout(
        HttpClient client,
        string token,
        Guid idempotencyKey,
        object body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/vwce/payouts")
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Add("X-CSRF-TOKEN", token);
        request.Headers.Add("Idempotency-Key", idempotencyKey.ToString());
        return client.SendAsync(request);
    }

    private static Task<HttpResponseMessage> SendPurchase(
        HttpClient client, Guid accountId, string token, Guid idempotencyKey, object body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/vwce/accounts/{accountId}/purchases")
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Add("X-CSRF-TOKEN", token);
        request.Headers.Add("Idempotency-Key", idempotencyKey.ToString());
        return client.SendAsync(request);
    }
}
