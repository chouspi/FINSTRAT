using System.Data;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.MarketData;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Finstrat.Api.Modules.Wealth;

public sealed class WealthSnapshotService(
    ApplicationDbContext dbContext,
    BtcPriceService btcPriceService,
    VwcePriceService vwcePriceService)
{
    public async Task CaptureAsync(
        Guid householdId, Guid userId, DateOnly snapshotDate, string source,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        var holdings = await ReadHoldingsAsync(connection, householdId, userId, cancellationToken);
        BtcPrice? btcPrice = holdings.BtcQuantity > 0
            ? await btcPriceService.GetAsync(cancellationToken) : null;
        VwcePrice? vwcePrice = holdings.VwceShares > 0
            ? await vwcePriceService.GetAsync(cancellationToken) : null;
        var btcValue = decimal.Round(holdings.BtcQuantity * (btcPrice?.PriceCzk ?? 0), 2);
        var vwceValue = decimal.Round(holdings.VwceShares * (vwcePrice?.PriceCzk ?? 0), 2);
        var grossAssets = btcValue + vwceValue;
        var trackedNetWorth = grossAssets - holdings.ConsumerDebt;
        var quality = btcPrice?.IsStale == true || vwcePrice?.IsStale == true ? "estimated" : "complete";
        var snapshotAt = DateTimeOffset.UtcNow;

        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            Guid? btcPriceId = btcPrice is null ? null : await PersistPriceAsync(
                connection, transaction, "BTC", btcPrice.PriceCzk, btcPrice.ObservedAt,
                btcPrice.Source, cancellationToken);
            Guid? vwcePriceId = vwcePrice is null ? null : await PersistPriceAsync(
                connection, transaction, "VWCE", vwcePrice.PriceCzk, vwcePrice.ObservedAt,
                vwcePrice.Source, cancellationToken);
            await using var command = new NpgsqlCommand("""
                INSERT INTO wealth_snapshots (
                  household_id, owner_user_id, snapshot_date, snapshot_at, source, quality,
                  btc_quantity, btc_price_czk, btc_value_czk, btc_cost_basis_czk,
                  vwce_shares, vwce_price_czk, vwce_value_czk, vwce_cost_basis_czk,
                  consumer_debt_czk, mortgage_debt_czk, gross_assets_czk,
                  tracked_net_worth_czk, btc_price_id, vwce_price_id
                ) VALUES (
                  @household_id, @user_id, @snapshot_date, @snapshot_at, @source, @quality,
                  @btc_quantity, @btc_price, @btc_value, @btc_basis,
                  @vwce_shares, @vwce_price, @vwce_value, @vwce_basis,
                  @consumer_debt, @mortgage_debt, @gross_assets,
                  @net_worth, @btc_price_id, @vwce_price_id
                )
                ON CONFLICT (household_id, owner_user_id, snapshot_date) DO UPDATE SET
                  snapshot_at = EXCLUDED.snapshot_at, source = EXCLUDED.source,
                  quality = EXCLUDED.quality, btc_quantity = EXCLUDED.btc_quantity,
                  btc_price_czk = EXCLUDED.btc_price_czk, btc_value_czk = EXCLUDED.btc_value_czk,
                  btc_cost_basis_czk = EXCLUDED.btc_cost_basis_czk,
                  vwce_shares = EXCLUDED.vwce_shares, vwce_price_czk = EXCLUDED.vwce_price_czk,
                  vwce_value_czk = EXCLUDED.vwce_value_czk,
                  vwce_cost_basis_czk = EXCLUDED.vwce_cost_basis_czk,
                  consumer_debt_czk = EXCLUDED.consumer_debt_czk,
                  mortgage_debt_czk = EXCLUDED.mortgage_debt_czk,
                  gross_assets_czk = EXCLUDED.gross_assets_czk,
                  tracked_net_worth_czk = EXCLUDED.tracked_net_worth_czk,
                  btc_price_id = EXCLUDED.btc_price_id, vwce_price_id = EXCLUDED.vwce_price_id
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("snapshot_date", snapshotDate);
            command.Parameters.AddWithValue("snapshot_at", snapshotAt);
            command.Parameters.AddWithValue("source", source);
            command.Parameters.AddWithValue("quality", quality);
            command.Parameters.AddWithValue("btc_quantity", holdings.BtcQuantity);
            command.Parameters.AddWithValue("btc_price", NpgsqlDbType.Numeric, (object?)btcPrice?.PriceCzk ?? DBNull.Value);
            command.Parameters.AddWithValue("btc_value", btcValue);
            command.Parameters.AddWithValue("btc_basis", holdings.BtcCostBasis);
            command.Parameters.AddWithValue("vwce_shares", holdings.VwceShares);
            command.Parameters.AddWithValue("vwce_price", NpgsqlDbType.Numeric, (object?)vwcePrice?.PriceCzk ?? DBNull.Value);
            command.Parameters.AddWithValue("vwce_value", vwceValue);
            command.Parameters.AddWithValue("vwce_basis", holdings.VwceCostBasis);
            command.Parameters.AddWithValue("consumer_debt", holdings.ConsumerDebt);
            command.Parameters.AddWithValue("mortgage_debt", holdings.MortgageDebt);
            command.Parameters.AddWithValue("gross_assets", grossAssets);
            command.Parameters.AddWithValue("net_worth", trackedNetWorth);
            command.Parameters.AddWithValue("btc_price_id", NpgsqlDbType.Uuid, (object?)btcPriceId ?? DBNull.Value);
            command.Parameters.AddWithValue("vwce_price_id", NpgsqlDbType.Uuid, (object?)vwcePriceId ?? DBNull.Value);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<WealthHistoryResponse> GetHistoryAsync(
        Guid householdId, Guid userId, int days, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            SELECT snapshot_date, snapshot_at, quality,
              btc_quantity, COALESCE(btc_price_czk, 0), btc_value_czk, btc_cost_basis_czk,
              vwce_shares, COALESCE(vwce_price_czk, 0), vwce_value_czk, vwce_cost_basis_czk,
              consumer_debt_czk, mortgage_debt_czk, gross_assets_czk, tracked_net_worth_czk
            FROM wealth_snapshots snapshot
            JOIN households household ON household.id = snapshot.household_id
            WHERE snapshot.household_id = @household_id AND snapshot.owner_user_id = @user_id
              AND snapshot_date >= (CURRENT_TIMESTAMP AT TIME ZONE household.time_zone)::date - @days
            ORDER BY snapshot_date
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("days", days);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var points = new List<WealthSnapshotResponse>();
        while (await reader.ReadAsync(cancellationToken))
            points.Add(new WealthSnapshotResponse(
                DateOnly.FromDateTime(reader.GetDateTime(0)), reader.GetFieldValue<DateTimeOffset>(1),
                reader.GetString(2), reader.GetDecimal(3), reader.GetDecimal(4),
                reader.GetDecimal(5), reader.GetDecimal(6), reader.GetDecimal(7),
                reader.GetDecimal(8), reader.GetDecimal(9), reader.GetDecimal(10),
                reader.GetDecimal(11), reader.GetDecimal(12), reader.GetDecimal(13), reader.GetDecimal(14)));
        return new WealthHistoryResponse(points.LastOrDefault(), points);
    }

    public async Task<IReadOnlyList<(Guid HouseholdId, Guid UserId, DateOnly LocalDate, bool IsDailyCutoff)>> ReadSnapshotTargetsAsync(
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            SELECT member.household_id, member.user_id,
              (now() AT TIME ZONE household.time_zone)::date,
              EXTRACT(hour FROM now() AT TIME ZONE household.time_zone) = 23
                AND EXTRACT(minute FROM now() AT TIME ZONE household.time_zone) >= 55
            FROM household_members member
            JOIN households household ON household.id = member.household_id
            JOIN users app_user ON app_user.id = member.user_id
            WHERE household.archived_at IS NULL AND app_user.disabled_at IS NULL AND NOT app_user.is_default
            """, connection);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var result = new List<(Guid, Guid, DateOnly, bool)>();
        while (await reader.ReadAsync(cancellationToken))
            result.Add((reader.GetGuid(0), reader.GetGuid(1),
                reader.GetFieldValue<DateOnly>(2), reader.GetBoolean(3)));
        return result;
    }

    public async Task<DateOnly> GetLocalDateAsync(
        Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            SELECT (now() AT TIME ZONE household.time_zone)::date
            FROM households household
            JOIN household_members member ON member.household_id = household.id
            WHERE household.id = @household_id AND member.user_id = @user_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
            throw new InvalidOperationException("Household time zone was not found.");
        return reader.GetFieldValue<DateOnly>(0);
    }

    private static async Task<Holdings> ReadHoldingsAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            WITH btc_remaining AS (
              SELECT GREATEST(lot.quantity_btc - COALESCE(SUM(allocation.quantity_btc), 0), 0) quantity,
                lot.unit_price_czk
              FROM btc_lots lot
              JOIN btc_accounts account ON account.household_id = lot.household_id AND account.id = lot.account_id
              LEFT JOIN btc_lot_allocations allocation ON allocation.household_id = lot.household_id AND allocation.lot_id = lot.id
              WHERE lot.household_id = @household_id AND account.owner_user_id = @user_id
                AND account.archived_at IS NULL
              GROUP BY lot.id
            ), vwce_remaining AS (
              SELECT GREATEST(lot.shares - COALESCE(SUM(allocation.shares), 0), 0) shares,
                lot.unit_price_czk
              FROM vwce_lots lot
              JOIN vwce_accounts account ON account.household_id = lot.household_id AND account.id = lot.account_id
              LEFT JOIN vwce_lot_allocations allocation ON allocation.household_id = lot.household_id AND allocation.lot_id = lot.id
              WHERE lot.household_id = @household_id AND account.owner_user_id = @user_id
                AND account.archived_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM vwce_lots replacement WHERE replacement.replaces_lot_id = lot.id)
              GROUP BY lot.id
            ), debt_totals AS (
              SELECT COALESCE(SUM(balance.balance_czk) FILTER (WHERE NOT debt.is_mortgage), 0) consumer,
                COALESCE(SUM(balance.balance_czk) FILTER (WHERE debt.is_mortgage), 0) mortgage
              FROM debts debt
              JOIN debt_balances balance ON balance.household_id = debt.household_id AND balance.debt_id = debt.id
              WHERE debt.household_id = @household_id AND debt.owner_user_id = @user_id
                AND debt.archived_at IS NULL AND balance.balance_czk > 0
            )
            SELECT COALESCE((SELECT SUM(quantity) FROM btc_remaining), 0),
              COALESCE((SELECT SUM(quantity * unit_price_czk) FROM btc_remaining WHERE unit_price_czk IS NOT NULL), 0),
              COALESCE((SELECT SUM(shares) FROM vwce_remaining), 0),
              COALESCE((SELECT SUM(shares * unit_price_czk) FROM vwce_remaining WHERE unit_price_czk IS NOT NULL), 0),
              consumer, mortgage FROM debt_totals
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return new Holdings(reader.GetDecimal(0), decimal.Round(reader.GetDecimal(1), 2),
            reader.GetDecimal(2), decimal.Round(reader.GetDecimal(3), 2),
            reader.GetDecimal(4), reader.GetDecimal(5));
    }

    private static async Task<Guid> PersistPriceAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, string instrument,
        decimal price, DateTimeOffset observedAt, string source, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            WITH inserted AS (
              INSERT INTO market_prices (instrument, quote_currency, price, observed_at, source)
              VALUES (@instrument, 'CZK', @price, @observed_at, @source)
              ON CONFLICT (instrument, quote_currency, observed_at, source) DO NOTHING
              RETURNING id
            )
            SELECT id FROM inserted
            UNION ALL
            SELECT id FROM market_prices WHERE instrument = @instrument AND quote_currency = 'CZK'
              AND observed_at = @observed_at AND source = @source
            LIMIT 1
            """, connection, transaction);
        command.Parameters.AddWithValue("instrument", instrument);
        command.Parameters.AddWithValue("price", price);
        command.Parameters.AddWithValue("observed_at", observedAt);
        command.Parameters.AddWithValue("source", source);
        return (Guid)(await command.ExecuteScalarAsync(cancellationToken)
            ?? throw new InvalidOperationException("Market price could not be persisted."));
    }

    private sealed record Holdings(
        decimal BtcQuantity, decimal BtcCostBasis, decimal VwceShares,
        decimal VwceCostBasis, decimal ConsumerDebt, decimal MortgageDebt);
}
