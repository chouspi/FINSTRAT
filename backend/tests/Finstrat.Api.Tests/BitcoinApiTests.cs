using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class BitcoinApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Overview_returns_only_accounts_accessible_to_current_user()
    {
        var ownAccountId = Guid.NewGuid();
        var hiddenAccountId = Guid.NewGuid();
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("""
                WITH context AS (
                  SELECT h.id AS household_id, u.id AS default_user_id
                  FROM households h CROSS JOIN users u
                  WHERE u.is_default
                  ORDER BY h.created_at
                  LIMIT 1
                ), other_user AS (
                  INSERT INTO users (
                    id, user_name, normalized_user_name, display_name,
                    security_stamp, concurrency_stamp
                  ) VALUES (
                    gen_random_uuid(), @other_name, upper(@other_name), 'Other user',
                    gen_random_uuid()::text, gen_random_uuid()::text
                  ) RETURNING id
                ), other_member AS (
                  INSERT INTO household_members (household_id, user_id, role)
                  SELECT context.household_id, other_user.id, 'owner'
                  FROM context, other_user
                ), own_account AS (
                  INSERT INTO btc_accounts (id, household_id, owner_user_id, name)
                  SELECT @own_account_id, context.household_id, context.default_user_id, @own_name
                  FROM context
                ), hidden_account AS (
                  INSERT INTO btc_accounts (id, household_id, owner_user_id, name)
                  SELECT @hidden_account_id, context.household_id, other_user.id, @hidden_name
                  FROM context, other_user
                )
                INSERT INTO btc_lots (
                  household_id, account_id, quantity_btc, unit_price_czk,
                  acquired_at, tax_acquired_at, note
                )
                SELECT context.household_id, @own_account_id, 1.25000000, 1000000.00,
                  now(), now(), 'Visible lot'
                FROM context;

                INSERT INTO btc_lots (
                  household_id, account_id, quantity_btc, unit_price_czk,
                  acquired_at, tax_acquired_at, note
                )
                SELECT household_id, @hidden_account_id, 9.00000000, 1000000.00,
                  now(), now(), 'Hidden lot'
                FROM btc_accounts WHERE id = @hidden_account_id;
                """, connection);
            command.Parameters.AddWithValue("other_name", $"other-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("own_account_id", ownAccountId);
            command.Parameters.AddWithValue("hidden_account_id", hiddenAccountId);
            command.Parameters.AddWithValue("own_name", $"Visible-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("hidden_name", $"Hidden-{Guid.NewGuid():N}");
            await command.ExecuteNonQueryAsync();
        }

        using var client = fixture.CreateClient();
        var response = await client.GetAsync("/api/bitcoin/overview");
        var payload = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1.25m, payload.GetProperty("totals").GetProperty("quantityBtc").GetDecimal());
        Assert.Equal(1, payload.GetProperty("totals").GetProperty("accountCount").GetInt32());
        var account = Assert.Single(payload.GetProperty("accounts").EnumerateArray());
        Assert.Equal(ownAccountId, account.GetProperty("id").GetGuid());
        Assert.Single(payload.GetProperty("recentMovements").EnumerateArray());
    }
}
