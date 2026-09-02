using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class StrategyApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Checkpoint_includes_only_legacy_contributions_and_tracks_purchase_corrections()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var baseAccount = Guid.NewGuid();
        var transferSource = Guid.NewGuid();
        var transferTarget = Guid.NewGuid();
        var purchaseAccount = Guid.NewGuid();
        var baseLot = Guid.NewGuid();
        var sourceLot = Guid.NewGuid();
        var mirrorLot = Guid.NewGuid();
        var purchaseLot = Guid.NewGuid();
        var transfer = Guid.NewGuid();
        var reallocation = Guid.NewGuid();
        var obligation = Guid.NewGuid();
        var expense = Guid.NewGuid();
        var disposal = Guid.NewGuid();
        var standaloneDisposal = Guid.NewGuid();
        var activatedAt = DateTimeOffset.UtcNow.AddDays(1);
        var contributedAt = activatedAt.AddDays(1);
        Guid householdId;
        Guid userId;

        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using (var identity = new NpgsqlCommand("SELECT member.household_id, member.user_id FROM household_members member JOIN users app_user ON app_user.id = member.user_id WHERE app_user.is_default LIMIT 1", connection))
            await using (var reader = await identity.ExecuteReaderAsync())
            {
                Assert.True(await reader.ReadAsync());
                householdId = reader.GetGuid(0);
                userId = reader.GetGuid(1);
            }
            await using var setup = new NpgsqlCommand("""
                INSERT INTO btc_accounts (id, household_id, owner_user_id, name) VALUES
                  (@base_account, @household_id, @user_id, @base_name),
                  (@source_account, @household_id, @user_id, @source_name),
                  (@target_account, @household_id, @user_id, @target_name),
                  (@purchase_account, @household_id, @user_id, @purchase_name);
                INSERT INTO btc_lots (id, household_id, account_id, quantity_btc, unit_price_czk, acquired_at, tax_acquired_at, created_at, created_by)
                VALUES
                  (@base_lot, @household_id, @base_account, 0.01000000, 1000000, now(), now(), @before_activation, @user_id),
                  (@source_lot, @household_id, @source_account, 0.10000000, 1000000, now(), now(), @before_activation, @user_id),
                  (@purchase_lot, @household_id, @purchase_account, 0.01000000, 1000000, now(), now(), @after_activation, @user_id);
                INSERT INTO btc_transfers (id, household_id, from_account_id, to_account_id, gross_quantity_btc, transferred_at, created_at, created_by)
                VALUES (@transfer, @household_id, @source_account, @target_account, 0.05000000, now(), @after_activation, @user_id);
                INSERT INTO btc_lots (id, household_id, account_id, quantity_btc, unit_price_czk, acquired_at, tax_acquired_at, source_transfer_id, source_lot_id, created_at, created_by)
                VALUES (@mirror_lot, @household_id, @target_account, 0.05000000, 1000000, now(), now(), @transfer, @source_lot, @after_activation, @user_id);
                INSERT INTO vwce_reallocations (id, household_id, amount_czk, executed_at, created_at, created_by)
                VALUES (@reallocation, @household_id, 40000, now(), @after_activation, @user_id);
                INSERT INTO deferred_vwce_obligations (id, household_id, owner_user_id, original_amount_czk, cancelled_amount_czk, deferred_at, created_at, created_by)
                VALUES (@obligation, @household_id, @user_id, 50000, 10000, current_date, @after_activation, @user_id);
                INSERT INTO life_expenses (id, household_id, amount_czk, category, spent_at, created_at, created_by)
                VALUES (@expense, @household_id, 5000, 'auto', now(), @after_activation, @user_id);
                INSERT INTO btc_disposals (id, household_id, account_id, kind, quantity_btc, unit_price_czk, disposed_at, life_expense_id, created_at, created_by)
                VALUES (@disposal, @household_id, @base_account, 'life_expense', 0.00100000, 5000000, now(), @expense, @after_activation, @user_id);
                INSERT INTO btc_disposals (id, household_id, account_id, kind, quantity_btc, unit_price_czk, disposed_at, created_at, created_by)
                VALUES (@standalone_disposal, @household_id, @source_account, 'standalone', 0.00100000, 5000000, now(), @after_activation, @user_id);
                INSERT INTO btc_strategy_states (household_id, owner_user_id, checkpoint_base_czk, activated_at)
                VALUES (@household_id, @user_id, 100000, @activated_at)
                ON CONFLICT (household_id, owner_user_id) DO UPDATE SET checkpoint_base_czk = 100000, activated_at = @activated_at;
                """, connection);
            setup.Parameters.AddWithValue("household_id", householdId);
            setup.Parameters.AddWithValue("user_id", userId);
            setup.Parameters.AddWithValue("base_account", baseAccount);
            setup.Parameters.AddWithValue("source_account", transferSource);
            setup.Parameters.AddWithValue("target_account", transferTarget);
            setup.Parameters.AddWithValue("purchase_account", purchaseAccount);
            setup.Parameters.AddWithValue("base_name", $"Strategy base {Guid.NewGuid():N}");
            setup.Parameters.AddWithValue("source_name", $"Strategy source {Guid.NewGuid():N}");
            setup.Parameters.AddWithValue("target_name", $"Strategy target {Guid.NewGuid():N}");
            setup.Parameters.AddWithValue("purchase_name", $"Strategy purchase {Guid.NewGuid():N}");
            setup.Parameters.AddWithValue("base_lot", baseLot);
            setup.Parameters.AddWithValue("source_lot", sourceLot);
            setup.Parameters.AddWithValue("purchase_lot", purchaseLot);
            setup.Parameters.AddWithValue("mirror_lot", mirrorLot);
            setup.Parameters.AddWithValue("transfer", transfer);
            setup.Parameters.AddWithValue("reallocation", reallocation);
            setup.Parameters.AddWithValue("obligation", obligation);
            setup.Parameters.AddWithValue("expense", expense);
            setup.Parameters.AddWithValue("disposal", disposal);
            setup.Parameters.AddWithValue("standalone_disposal", standaloneDisposal);
            setup.Parameters.AddWithValue("before_activation", activatedAt.AddDays(-1));
            setup.Parameters.AddWithValue("after_activation", contributedAt);
            setup.Parameters.AddWithValue("activated_at", activatedAt);
            await setup.ExecuteNonQueryAsync();
        }

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/strategy/overview");
        Assert.Equal(185000m, overview.GetProperty("checkpointValueCzk").GetDecimal());

        var token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        var update = new HttpRequestMessage(HttpMethod.Put, $"/api/bitcoin/movements/{purchaseLot}/purchase")
        {
            Content = JsonContent.Create(new { quantityBtc = "0.02000000", unitPriceCzk = "1000000", acquiredAt = DateTimeOffset.UtcNow.ToString("O"), txid = (string?)null, note = "Corrected" }),
        };
        update.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(update)).StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/strategy/overview");
        Assert.Equal(195000m, overview.GetProperty("checkpointValueCzk").GetDecimal());

        token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/bitcoin/movements/{purchaseLot}/purchase");
        delete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/strategy/overview");
        Assert.Equal(175000m, overview.GetProperty("checkpointValueCzk").GetDecimal());

        token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        var archive = new HttpRequestMessage(HttpMethod.Delete, $"/api/bitcoin/accounts/{baseAccount}");
        archive.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(archive)).StatusCode);
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var state = new NpgsqlCommand("SELECT COUNT(*) FROM btc_strategy_states WHERE household_id = @household_id AND owner_user_id = @user_id", connection);
            state.Parameters.AddWithValue("household_id", householdId);
            state.Parameters.AddWithValue("user_id", userId);
            Assert.Equal(0L, (long)(await state.ExecuteScalarAsync())!);
        }
    }

    [Fact]
    public async Task Strategy_uses_legacy_defaults_and_validates_persisted_settings()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/strategy/overview");
        Assert.Equal(100000m, overview.GetProperty("settings").GetProperty("checkpointActivationThresholdCzk").GetDecimal());
        Assert.Equal("AKUMULOVAT", overview.GetProperty("recommendation").GetString());

        var token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/strategy/settings")
        {
            Content = JsonContent.Create(new
            {
                btcTaxPeriodYears = 3, checkpointAuto = false, checkpointActivationThresholdCzk = 150000,
                checkpointTriggerFloorCzk = 25000, checkpointTriggerPercent = 12,
                realizationStepProfitCzk = 30000, realizationStepTransferCzk = 15000,
                vwceRentRatePercent = 2.5m,
            }),
        };
        request.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(request)).StatusCode);
        overview = await client.GetFromJsonAsync<JsonElement>("/api/strategy/overview");
        Assert.Equal(150000m, overview.GetProperty("settings").GetProperty("checkpointActivationThresholdCzk").GetDecimal());
        Assert.False(overview.GetProperty("settings").GetProperty("checkpointAuto").GetBoolean());
        var vwceOverview = await client.GetFromJsonAsync<JsonElement>("/api/vwce/overview");
        Assert.Equal(2.5m, vwceOverview.GetProperty("totals").GetProperty("rentRatePercent").GetDecimal());

        token = (await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery")).GetProperty("token").GetString()!;
        request = new HttpRequestMessage(HttpMethod.Put, "/api/strategy/settings")
        {
            Content = JsonContent.Create(new
            {
                btcTaxPeriodYears = 3, checkpointAuto = true, checkpointActivationThresholdCzk = 0,
                checkpointTriggerFloorCzk = 25000, checkpointTriggerPercent = 12,
                realizationStepProfitCzk = 30000, realizationStepTransferCzk = 15000,
                vwceRentRatePercent = 2.5m,
            }),
        };
        request.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(request)).StatusCode);
    }
}
