using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.Strategy;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Finstrat.Api.Modules.Taxes;

public sealed class TaxesService(ApplicationDbContext dbContext, StrategyService strategyService)
{
    public async Task<TaxesOverviewResponse> GetOverviewAsync(Guid householdId, Guid userId, CancellationToken ct)
    {
        StrategyOverviewResponse? strategy = null;
        try
        {
            strategy = await strategyService.GetOverviewAsync(householdId, userId, ct);
        }
        catch (Exception exception) when (
            (exception is HttpRequestException or JsonException or InvalidOperationException or TaskCanceledException)
            && !ct.IsCancellationRequested)
        {
            // Tax lots and the deferred pool remain usable while live market data is unavailable.
        }
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        var shouldClose = connection.State != ConnectionState.Open;
        if (shouldClose) await connection.OpenAsync(ct);
        try
        {
            var taxPeriodYears = strategy?.Settings.BtcTaxPeriodYears
                ?? await ReadTaxPeriodYearsAsync(connection, householdId, userId, ct);
            var today = await ReadTodayAsync(connection, householdId, ct);
            var lots = await ReadLotsAsync(connection, householdId, userId, taxPeriodYears, today, ct);
            var obligations = await ReadObligationsAsync(connection, householdId, userId, ct);
            var taxFree = lots.Where(lot => lot.IsTimeTestSatisfied).Sum(lot => lot.RemainingQuantityBtc);
            var taxable = lots.Where(lot => !lot.IsTimeTestSatisfied).Sum(lot => lot.RemainingQuantityBtc);
            var next = lots.Where(lot => !lot.IsTimeTestSatisfied).Select(lot => lot.TimeTestDate).DefaultIfEmpty().Min();
            var pool = obligations.Sum(obligation => obligation.RemainingAmountCzk);
            return new(taxPeriodYears, taxFree, taxable,
                next == default ? null : next, lots, pool, obligations,
                strategy?.RecommendedTransferCzk ?? 0,
                strategy?.Recommendation == "PRODAT" && strategy.RecommendedTransferCzk > 0 && taxFree <= 0.000000005m);
        }
        finally { if (shouldClose) await connection.CloseAsync(); }
    }

    public async Task<DeferRecommendedTransferResponse> DeferRecommendedAsync(
        Guid householdId, Guid userId, Guid idempotencyKey,
        DeferRecommendedTransferRequest request, CancellationToken ct)
    {
        var note = string.IsNullOrWhiteSpace(request.Note) ? null : request.Note.Trim();
        if (note?.Length > 500) throw new TaxesValidationException("Poznámka může mít nejvýše 500 znaků.");
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { operation = "defer_vwce", userId, note }))));
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        try
        {
            await using var register = new NpgsqlCommand("INSERT INTO idempotency_keys (household_id,key,request_hash,expires_at) VALUES (@h,@k,@r,now()+interval '24 hours') ON CONFLICT DO NOTHING", connection, transaction);
            register.Parameters.AddWithValue("h", householdId); register.Parameters.AddWithValue("k", idempotencyKey); register.Parameters.AddWithValue("r", hash);
            if (await register.ExecuteNonQueryAsync(ct) == 0)
            {
                await using var replay = new NpgsqlCommand("SELECT request_hash,response_body FROM idempotency_keys WHERE household_id=@h AND key=@k", connection, transaction);
                replay.Parameters.AddWithValue("h", householdId); replay.Parameters.AddWithValue("k", idempotencyKey);
                await using var reader = await replay.ExecuteReaderAsync(ct); await reader.ReadAsync(ct);
                if (reader.GetString(0) != hash) throw new TaxesValidationException("Idempotency key už byl použit.");
                if (reader.IsDBNull(1)) throw new TaxesValidationException("Stejné odložení se zpracovává.");
                var stored = JsonSerializer.Deserialize<DeferRecommendedTransferResponse>(reader.GetString(1))!;
                await reader.DisposeAsync(); await transaction.CommitAsync(ct); return stored;
            }
            await using var state = new NpgsqlCommand("SELECT 1 FROM btc_strategy_states WHERE household_id=@h AND owner_user_id=@u FOR UPDATE", connection, transaction);
            state.Parameters.AddWithValue("h", householdId); state.Parameters.AddWithValue("u", userId);
            if (await state.ExecuteScalarAsync(ct) is null) throw new TaxesValidationException("Checkpoint není aktivní.");
            var overview = await GetOverviewAsync(householdId, userId, ct);
            if (!overview.CanDeferRecommendedTransfer)
                throw new TaxesValidationException("Doporučenou realizaci nyní nelze odložit.");
            var amount = overview.RecommendedTransferCzk;
            var id = Guid.NewGuid();
            await using var insert = new NpgsqlCommand("""
                INSERT INTO deferred_vwce_obligations
                  (id,household_id,owner_user_id,original_amount_czk,deferred_at,note,created_by)
                VALUES (@id,@h,@u,@amount,current_date,@note,@u);
                INSERT INTO audit_events (household_id,actor_user_id,event_type,entity_type,entity_id,description,metadata)
                VALUES (@h,@u,'deferred_vwce_created','deferred_vwce_obligation',@id,'Deferred VWCE realization created',jsonb_build_object('amount_czk',@amount));
                """, connection, transaction);
            insert.Parameters.AddWithValue("id", id); insert.Parameters.AddWithValue("h", householdId); insert.Parameters.AddWithValue("u", userId);
            insert.Parameters.AddWithValue("amount", amount); insert.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
            await insert.ExecuteNonQueryAsync(ct);
            var result = new DeferRecommendedTransferResponse(id, amount, overview.DeferredVwceCzk + amount);
            await using var complete = new NpgsqlCommand("UPDATE idempotency_keys SET response_status=201,response_body=@body WHERE household_id=@h AND key=@k", connection, transaction);
            complete.Parameters.AddWithValue("h", householdId); complete.Parameters.AddWithValue("k", idempotencyKey); complete.Parameters.AddWithValue("body", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(result));
            await complete.ExecuteNonQueryAsync(ct); await transaction.CommitAsync(ct); return result;
        }
        catch { await transaction.RollbackAsync(CancellationToken.None); throw; }
    }

    private static async Task<DateOnly> ReadTodayAsync(NpgsqlConnection connection, Guid householdId, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("SELECT (CURRENT_TIMESTAMP AT TIME ZONE time_zone)::date FROM households WHERE id=@h", connection);
        command.Parameters.AddWithValue("h", householdId);
        return (DateOnly)(await command.ExecuteScalarAsync(ct))!;
    }

    private static async Task<short> ReadTaxPeriodYearsAsync(NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("SELECT COALESCE((SELECT btc_tax_period_years FROM btc_strategy_settings WHERE household_id=@h AND owner_user_id=@u),3::smallint)", connection);
        command.Parameters.AddWithValue("h", householdId);
        command.Parameters.AddWithValue("u", userId);
        return (short)(await command.ExecuteScalarAsync(ct))!;
    }

    private static async Task<List<TaxLotResponse>> ReadLotsAsync(NpgsqlConnection connection, Guid householdId, Guid userId, short years, DateOnly today, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT lot.id,account.name,GREATEST(lot.quantity_btc-COALESCE(SUM(allocation.quantity_btc),0),0),
              lot.unit_price_czk,lot.tax_acquired_at
            FROM btc_lots lot JOIN btc_accounts account ON account.household_id=lot.household_id AND account.id=lot.account_id
            LEFT JOIN btc_lot_allocations allocation ON allocation.household_id=lot.household_id AND allocation.lot_id=lot.id
            WHERE lot.household_id=@h AND account.owner_user_id=@u AND account.archived_at IS NULL
            GROUP BY lot.id,account.name HAVING GREATEST(lot.quantity_btc-COALESCE(SUM(allocation.quantity_btc),0),0)>0
            ORDER BY lot.tax_acquired_at,lot.id
            """, connection);
        command.Parameters.AddWithValue("h", householdId); command.Parameters.AddWithValue("u", userId);
        await using var reader = await command.ExecuteReaderAsync(ct); var result = new List<TaxLotResponse>();
        while (await reader.ReadAsync(ct))
        {
            var acquired = DateOnly.FromDateTime(reader.GetDateTime(4)); var maturity = acquired.AddYears(years);
            result.Add(new(reader.GetGuid(0), reader.GetString(1), reader.GetDecimal(2), reader.IsDBNull(3) ? null : reader.GetDecimal(3), acquired, maturity, maturity <= today));
        }
        return result;
    }

    private static async Task<List<DeferredVwceObligationResponse>> ReadObligationsAsync(NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT obligation.id,obligation.original_amount_czk,COALESCE(SUM(allocation.amount_czk),0),
              obligation.cancelled_amount_czk,GREATEST(obligation.original_amount_czk-obligation.cancelled_amount_czk-COALESCE(SUM(allocation.amount_czk),0),0),
              obligation.deferred_at,obligation.completed_at,obligation.note
            FROM deferred_vwce_obligations obligation LEFT JOIN deferred_vwce_allocations allocation
              ON allocation.household_id=obligation.household_id AND allocation.obligation_id=obligation.id
            WHERE obligation.household_id=@h AND obligation.owner_user_id=@u
            GROUP BY obligation.id ORDER BY obligation.deferred_at DESC,obligation.id DESC
            """, connection);
        command.Parameters.AddWithValue("h", householdId); command.Parameters.AddWithValue("u", userId);
        await using var reader = await command.ExecuteReaderAsync(ct); var result = new List<DeferredVwceObligationResponse>();
        while (await reader.ReadAsync(ct)) result.Add(new(reader.GetGuid(0),reader.GetDecimal(1),reader.GetDecimal(2),reader.GetDecimal(3),reader.GetDecimal(4),reader.GetFieldValue<DateOnly>(5),reader.IsDBNull(6)?null:reader.GetFieldValue<DateOnly>(6),reader.IsDBNull(7)?null:reader.GetString(7)));
        return result;
    }
}

public sealed class TaxesValidationException(string message) : Exception(message);
