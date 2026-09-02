using System.Data;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.MarketData;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Finstrat.Api.Modules.Strategy;

public sealed class StrategyService(ApplicationDbContext dbContext, BtcPriceService btcPriceService)
{
    private static readonly StrategySettingsResponse Defaults = new(3, true, 100000, 20000, 10, 20000, 10000, 2);

    public async Task<StrategyOverviewResponse> GetOverviewAsync(
        Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        var shouldClose = connection.State != ConnectionState.Open;
        if (shouldClose) await connection.OpenAsync(cancellationToken);
        try
        {
            var settings = await ReadSettingsAsync(connection, householdId, userId, cancellationToken);
            var quantity = await ReadQuantityAsync(connection, householdId, userId, cancellationToken);
            var price = await btcPriceService.GetAsync(cancellationToken);
            var portfolioValue = decimal.Round(quantity * price.PriceCzk, 2);
            var state = await ReadStateAsync(connection, householdId, userId, cancellationToken);
            if (state is null && settings.CheckpointAuto && portfolioValue >= settings.CheckpointActivationThresholdCzk)
            {
                await ActivateAsync(connection, householdId, userId, portfolioValue, cancellationToken);
                state = new StrategyState(portfolioValue, DateTimeOffset.UtcNow);
            }

            if (state is null)
            {
                var progress = Percent(portfolioValue, settings.CheckpointActivationThresholdCzk);
                return new(settings, quantity, price.PriceCzk, portfolioValue, false, null, 0, 0,
                    settings.CheckpointActivationThresholdCzk, progress,
                    Math.Max(0, settings.CheckpointActivationThresholdCzk - portfolioValue), 0, "AKUMULOVAT");
            }

            var adjustment = await ReadCheckpointAdjustmentAsync(
                connection, householdId, userId, state.ActivatedAt, cancellationToken);
            var checkpoint = Math.Max(0, state.BaseValueCzk + adjustment);
            var profit = portfolioValue - checkpoint;
            var trigger = Math.Max(settings.CheckpointTriggerFloorCzk,
                checkpoint * settings.CheckpointTriggerPercent / 100);
            var triggered = profit >= trigger;
            var recommended = triggered
                ? decimal.Floor(profit / settings.RealizationStepProfitCzk) * settings.RealizationStepTransferCzk
                : 0;
            return new(settings, quantity, price.PriceCzk, portfolioValue, true, checkpoint, profit,
                checkpoint > 0 ? decimal.Round(profit / checkpoint * 100, 2) : 0,
                trigger, Percent(profit, trigger), Math.Max(0, trigger - profit), recommended,
                triggered ? "PRODAT" : "DRŽET");
        }
        finally
        {
            if (shouldClose) await connection.CloseAsync();
        }
    }

    public async Task<StrategySettingsResponse> UpdateSettingsAsync(
        Guid householdId, Guid userId, UpdateStrategySettingsRequest request,
        CancellationToken cancellationToken)
    {
        Validate(request);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            INSERT INTO btc_strategy_settings (
              household_id, owner_user_id, btc_tax_period_years, checkpoint_auto,
              checkpoint_activation_threshold_czk, checkpoint_trigger_floor_czk,
              checkpoint_trigger_percent, realization_step_profit_czk,
              realization_step_transfer_czk, vwce_rent_rate_percent
            ) VALUES (@household_id, @user_id, @tax_years, @auto, @activation, @floor,
              @trigger_percent, @step_profit, @step_transfer, @rent)
            ON CONFLICT (household_id, owner_user_id) DO UPDATE SET
              btc_tax_period_years = EXCLUDED.btc_tax_period_years,
              checkpoint_auto = EXCLUDED.checkpoint_auto,
              checkpoint_activation_threshold_czk = EXCLUDED.checkpoint_activation_threshold_czk,
              checkpoint_trigger_floor_czk = EXCLUDED.checkpoint_trigger_floor_czk,
              checkpoint_trigger_percent = EXCLUDED.checkpoint_trigger_percent,
              realization_step_profit_czk = EXCLUDED.realization_step_profit_czk,
              realization_step_transfer_czk = EXCLUDED.realization_step_transfer_czk,
              vwce_rent_rate_percent = EXCLUDED.vwce_rent_rate_percent,
              updated_at = now()
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("tax_years", request.BtcTaxPeriodYears);
        command.Parameters.AddWithValue("auto", request.CheckpointAuto);
        command.Parameters.AddWithValue("activation", request.CheckpointActivationThresholdCzk);
        command.Parameters.AddWithValue("floor", request.CheckpointTriggerFloorCzk);
        command.Parameters.AddWithValue("trigger_percent", request.CheckpointTriggerPercent);
        command.Parameters.AddWithValue("step_profit", request.RealizationStepProfitCzk);
        command.Parameters.AddWithValue("step_transfer", request.RealizationStepTransferCzk);
        command.Parameters.AddWithValue("rent", request.VwceRentRatePercent);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await ReadSettingsAsync(connection, householdId, userId, cancellationToken);
    }

    private static async Task<StrategySettingsResponse> ReadSettingsAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT btc_tax_period_years, checkpoint_auto, checkpoint_activation_threshold_czk,
              checkpoint_trigger_floor_czk, checkpoint_trigger_percent, realization_step_profit_czk,
              realization_step_transfer_czk, vwce_rent_rate_percent
            FROM btc_strategy_settings WHERE household_id = @household_id AND owner_user_id = @user_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new(reader.GetInt16(0), reader.GetBoolean(1), reader.GetDecimal(2), reader.GetDecimal(3),
                reader.GetDecimal(4), reader.GetDecimal(5), reader.GetDecimal(6), reader.GetDecimal(7))
            : Defaults;
    }

    private static async Task<decimal> ReadQuantityAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            WITH remaining AS (
              SELECT GREATEST(lot.quantity_btc - COALESCE(SUM(allocation.quantity_btc), 0), 0) quantity
              FROM btc_lots lot
              JOIN btc_accounts account ON account.household_id = lot.household_id AND account.id = lot.account_id
              LEFT JOIN btc_lot_allocations allocation ON allocation.household_id = lot.household_id AND allocation.lot_id = lot.id
              WHERE lot.household_id = @household_id AND account.owner_user_id = @user_id AND account.archived_at IS NULL
              GROUP BY lot.id
            ) SELECT COALESCE(SUM(quantity), 0) FROM remaining
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        return (decimal)(await command.ExecuteScalarAsync(cancellationToken) ?? 0m);
    }

    private static async Task<StrategyState?> ReadStateAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT checkpoint_base_czk, activated_at FROM btc_strategy_states
            WHERE household_id = @household_id AND owner_user_id = @user_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new(reader.GetDecimal(0), reader.GetFieldValue<DateTimeOffset>(1)) : null;
    }

    private static async Task ActivateAsync(NpgsqlConnection connection, Guid householdId, Guid userId,
        decimal value, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            INSERT INTO btc_strategy_states (household_id, owner_user_id, checkpoint_base_czk)
            VALUES (@household_id, @user_id, @value) ON CONFLICT DO NOTHING
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("value", value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<decimal> ReadCheckpointAdjustmentAsync(NpgsqlConnection connection,
        Guid householdId, Guid userId, DateTimeOffset activatedAt, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT
              COALESCE((SELECT SUM(lot.quantity_btc * lot.unit_price_czk)
                FROM btc_lots lot JOIN btc_accounts account
                  ON account.household_id = lot.household_id AND account.id = lot.account_id
                WHERE lot.household_id = @household_id AND account.owner_user_id = @user_id
                  AND account.archived_at IS NULL AND lot.source_transfer_id IS NULL
                  AND lot.created_at > @activated_at), 0)
              + COALESCE((SELECT SUM(reallocation.amount_czk) FROM vwce_reallocations reallocation
                WHERE reallocation.household_id = @household_id AND reallocation.created_by = @user_id
                  AND reallocation.created_at > @activated_at), 0)
              + COALESCE((SELECT SUM(obligation.original_amount_czk - obligation.cancelled_amount_czk)
                FROM deferred_vwce_obligations obligation
                WHERE obligation.household_id = @household_id AND obligation.owner_user_id = @user_id
                  AND obligation.created_at > @activated_at), 0)
              - COALESCE((SELECT SUM(expense.amount_czk) FROM life_expenses expense
                WHERE expense.household_id = @household_id AND expense.created_at > @activated_at
                  AND EXISTS (
                    SELECT 1 FROM btc_disposals disposal
                    JOIN btc_accounts account ON account.household_id = disposal.household_id
                      AND account.id = disposal.account_id
                    WHERE disposal.household_id = expense.household_id
                      AND disposal.life_expense_id = expense.id
                      AND account.owner_user_id = @user_id
                  )), 0)
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("activated_at", activatedAt);
        return (decimal)(await command.ExecuteScalarAsync(cancellationToken) ?? 0m);
    }

    private static decimal Percent(decimal value, decimal target) => target <= 0
        ? 100 : Math.Clamp(decimal.Round(value / target * 100, 2), 0, 100);

    private static void Validate(UpdateStrategySettingsRequest request)
    {
        if (request.BtcTaxPeriodYears is < 1 or > 20)
            throw new StrategyValidationException("Daňový časový test musí být mezi 1 a 20 lety.");
        if (request.CheckpointActivationThresholdCzk <= 0 || request.CheckpointTriggerFloorCzk < 0
            || request.RealizationStepProfitCzk <= 0 || request.RealizationStepTransferCzk <= 0)
            throw new StrategyValidationException("Částky strategie musí být kladné; spodní hranice může být nula.");
        if (request.CheckpointTriggerPercent is < 0 or > 100 || request.VwceRentRatePercent is < 0 or > 100)
            throw new StrategyValidationException("Procenta strategie musí být mezi 0 a 100.");
    }

    private sealed record StrategyState(decimal BaseValueCzk, DateTimeOffset ActivatedAt);
}

public sealed class StrategyValidationException(string message) : Exception(message);
