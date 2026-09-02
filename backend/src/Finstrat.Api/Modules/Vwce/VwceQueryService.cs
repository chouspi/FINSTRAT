using System.Data;
using Finstrat.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Finstrat.Api.Modules.Vwce;

public sealed class VwceQueryService(ApplicationDbContext dbContext)
{
    public async Task<IReadOnlyList<VwceMovementResponse>> GetAccountMovementsAsync(
        Guid householdId,
        Guid userId,
        Guid accountId,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            WITH accessible_account AS (
              SELECT account.id, account.household_id, account.name
              FROM vwce_accounts account
              WHERE account.household_id = @household_id AND account.id = @account_id
                AND account.archived_at IS NULL
                AND (
                  account.owner_user_id = @user_id
                  OR EXISTS (
                    SELECT 1 FROM vwce_account_shares share
                    WHERE share.household_id = account.household_id
                      AND share.account_id = account.id AND share.user_id = @user_id
                  )
                )
            ), movements AS (
              SELECT lot.id, account.id AS account_id, account.name AS account_name,
                CASE WHEN lot.provisional THEN 'provisional_purchase'
                  WHEN lot.replaces_lot_id IS NOT NULL THEN 'replacement_purchase'
                  ELSE 'purchase' END AS type,
                lot.shares, lot.unit_price_czk, NULL::numeric AS proceeds_czk,
                lot.acquired_at AS occurred_at, lot.note,
                NOT lot.provisional AND lot.unit_price_czk IS NOT NULL
                  AND lot.source_reallocation_id IS NULL AND lot.replaces_lot_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM vwce_lot_allocations allocation WHERE allocation.lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM deferred_vwce_allocations allocation WHERE allocation.vwce_lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM vwce_lots replacement WHERE replacement.replaces_lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM vwce_lots later WHERE later.account_id = lot.account_id AND (later.acquired_at, later.id) > (lot.acquired_at, lot.id))
                  AND NOT EXISTS (SELECT 1 FROM vwce_disposals later WHERE later.account_id = lot.account_id AND later.disposed_at >= lot.acquired_at) AS can_edit,
                NOT lot.provisional AND lot.unit_price_czk IS NOT NULL
                  AND lot.source_reallocation_id IS NULL AND lot.replaces_lot_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM vwce_lot_allocations allocation WHERE allocation.lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM deferred_vwce_allocations allocation WHERE allocation.vwce_lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM vwce_lots replacement WHERE replacement.replaces_lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM vwce_lots later WHERE later.account_id = lot.account_id AND (later.acquired_at, later.id) > (lot.acquired_at, lot.id))
                  AND NOT EXISTS (SELECT 1 FROM vwce_disposals later WHERE later.account_id = lot.account_id AND later.disposed_at >= lot.acquired_at) AS can_delete
              FROM accessible_account account
              JOIN vwce_lots lot ON lot.household_id = account.household_id AND lot.account_id = account.id
              WHERE NOT EXISTS (
                SELECT 1 FROM vwce_lots replacement
                WHERE replacement.household_id = lot.household_id AND replacement.replaces_lot_id = lot.id
              )
              UNION ALL
              SELECT disposal.id, account.id, account.name, disposal.kind,
                -disposal.shares, disposal.unit_price_czk, disposal.proceeds_czk,
                disposal.disposed_at, disposal.note, false, false
              FROM accessible_account account
              JOIN vwce_disposals disposal
                ON disposal.household_id = account.household_id AND disposal.account_id = account.id
            )
            SELECT id, account_id, account_name, type, shares, unit_price_czk,
              proceeds_czk, occurred_at, note, can_edit, can_delete
            FROM movements ORDER BY occurred_at DESC, id DESC
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("account_id", accountId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var movements = new List<VwceMovementResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            movements.Add(new VwceMovementResponse(
                reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
                reader.GetDecimal(4), reader.IsDBNull(5) ? null : reader.GetDecimal(5),
                reader.IsDBNull(6) ? null : reader.GetDecimal(6), reader.GetDateTime(7),
                reader.IsDBNull(8) ? null : reader.GetString(8), reader.GetBoolean(9), reader.GetBoolean(10)));
        }
        return movements;
    }

    public async Task<VwceOverviewResponse> GetOverviewAsync(
        Guid householdId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        var shouldClose = connection.State != ConnectionState.Open;
        if (shouldClose) await connection.OpenAsync(cancellationToken);
        try
        {
            var accounts = await ReadAccountsAsync(connection, householdId, userId, cancellationToken);
            var movements = await ReadMovementsAsync(connection, householdId, userId, cancellationToken);
            var rentRatePercent = await ReadRentRateAsync(connection, householdId, userId, cancellationToken);
            return new VwceOverviewResponse(
                new VwceTotalsResponse(
                    accounts.Sum(account => account.Shares),
                    accounts.Sum(account => account.CostBasisCzk),
                    accounts.Count,
                    accounts.All(account => account.CostBasisComplete),
                    accounts.Sum(account => account.ProvisionalLotCount),
                    rentRatePercent),
                accounts,
                movements);
        }
        finally
        {
            if (shouldClose) await connection.CloseAsync();
        }
    }

    private static async Task<decimal> ReadRentRateAsync(
        NpgsqlConnection connection,
        Guid householdId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT vwce_rent_rate_percent
            FROM btc_strategy_settings
            WHERE household_id = @household_id AND owner_user_id = @user_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        return await command.ExecuteScalarAsync(cancellationToken) is decimal rate ? rate : 2m;
    }

    private static async Task<List<VwceAccountResponse>> ReadAccountsAsync(
        NpgsqlConnection connection,
        Guid householdId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            WITH accessible_accounts AS (
              SELECT account.*
              FROM vwce_accounts account
              WHERE account.household_id = @household_id
                AND account.archived_at IS NULL
                AND (
                  account.owner_user_id = @user_id
                  OR EXISTS (
                    SELECT 1 FROM vwce_account_shares share
                    WHERE share.household_id = account.household_id
                      AND share.account_id = account.id AND share.user_id = @user_id
                  )
                )
            )
            SELECT
              account.id, account.name, account.description, owner.display_name,
              COALESCE(lots.remaining_shares, 0)::numeric(20,8),
              COALESCE(lots.cost_basis_czk, 0)::numeric(20,2),
              COALESCE(lots.basis_complete, true),
              COALESCE(lots.lot_count, 0),
              COALESCE(disposals.disposal_count, 0),
              COALESCE(lots.provisional_count, 0),
              GREATEST(lots.latest_at, disposals.latest_at),
              account.owner_user_id = @user_id,
              account.owner_user_id = @user_id OR EXISTS (
                SELECT 1 FROM vwce_account_shares managed_share
                JOIN users acting_user ON acting_user.id = managed_share.user_id
                WHERE managed_share.household_id = account.household_id
                  AND managed_share.account_id = account.id
                  AND managed_share.user_id = @user_id AND acting_user.is_default
              ),
              account.owner_user_id = @user_id AND NOT owner.is_default,
              EXISTS (
                SELECT 1 FROM vwce_account_shares share
                JOIN users shared_user ON shared_user.id = share.user_id
                WHERE share.household_id = account.household_id
                  AND share.account_id = account.id AND shared_user.is_default
              )
            FROM accessible_accounts account
            JOIN users owner ON owner.id = account.owner_user_id
            LEFT JOIN LATERAL (
              SELECT
                SUM(GREATEST(lot.shares - COALESCE(allocated.shares, 0), 0)) AS remaining_shares,
                SUM(GREATEST(lot.shares - COALESCE(allocated.shares, 0), 0) * lot.unit_price_czk)
                  FILTER (WHERE lot.unit_price_czk IS NOT NULL) AS cost_basis_czk,
                COALESCE(BOOL_AND(lot.unit_price_czk IS NOT NULL)
                  FILTER (WHERE lot.shares - COALESCE(allocated.shares, 0) > 0), true) AS basis_complete,
                COUNT(*)::int AS lot_count,
                COUNT(*) FILTER (
                  WHERE lot.provisional AND lot.shares - COALESCE(allocated.shares, 0) > 0
                )::int AS provisional_count,
                MAX(lot.acquired_at) AS latest_at
              FROM vwce_lots lot
              LEFT JOIN LATERAL (
                SELECT SUM(allocation.shares) AS shares
                FROM vwce_lot_allocations allocation
                WHERE allocation.household_id = lot.household_id AND allocation.lot_id = lot.id
              ) allocated ON true
              WHERE lot.household_id = account.household_id AND lot.account_id = account.id
                AND NOT EXISTS (
                  SELECT 1 FROM vwce_lots replacement
                  WHERE replacement.household_id = lot.household_id
                    AND replacement.replaces_lot_id = lot.id
                )
            ) lots ON true
            LEFT JOIN LATERAL (
              SELECT COUNT(*)::int AS disposal_count, MAX(disposal.disposed_at) AS latest_at
              FROM vwce_disposals disposal
              WHERE disposal.household_id = account.household_id AND disposal.account_id = account.id
            ) disposals ON true
            ORDER BY account.created_at, account.id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var accounts = new List<VwceAccountResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            accounts.Add(new VwceAccountResponse(
                reader.GetGuid(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.GetString(3), reader.GetDecimal(4), reader.GetDecimal(5), reader.GetBoolean(6),
                reader.GetInt32(7), reader.GetInt32(8), reader.GetInt32(9),
                reader.IsDBNull(10) ? null : reader.GetDateTime(10),
                reader.GetBoolean(11), reader.GetBoolean(12), reader.GetBoolean(13), reader.GetBoolean(14)));
        }
        return accounts;
    }

    private static async Task<List<VwceMovementResponse>> ReadMovementsAsync(
        NpgsqlConnection connection,
        Guid householdId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            WITH accessible_accounts AS (
              SELECT account.id, account.household_id, account.name
              FROM vwce_accounts account
              WHERE account.household_id = @household_id
                AND account.archived_at IS NULL
                AND (
                  account.owner_user_id = @user_id
                  OR EXISTS (
                    SELECT 1 FROM vwce_account_shares share
                    WHERE share.household_id = account.household_id
                      AND share.account_id = account.id AND share.user_id = @user_id
                  )
                )
            ), movements AS (
              SELECT lot.id, account.id AS account_id, account.name AS account_name,
                CASE
                  WHEN lot.provisional THEN 'provisional_purchase'
                  WHEN lot.replaces_lot_id IS NOT NULL THEN 'replacement_purchase'
                  ELSE 'purchase'
                END AS type,
                lot.shares, lot.unit_price_czk, NULL::numeric AS proceeds_czk,
                 lot.acquired_at AS occurred_at, lot.note, false AS can_edit, false AS can_delete
              FROM accessible_accounts account
              JOIN vwce_lots lot ON lot.household_id = account.household_id AND lot.account_id = account.id
              WHERE NOT EXISTS (
                SELECT 1 FROM vwce_lots replacement
                WHERE replacement.household_id = lot.household_id AND replacement.replaces_lot_id = lot.id
              )
              UNION ALL
              SELECT disposal.id, account.id, account.name, disposal.kind,
                -disposal.shares, disposal.unit_price_czk, disposal.proceeds_czk,
                 disposal.disposed_at, disposal.note, false, false
              FROM accessible_accounts account
              JOIN vwce_disposals disposal
                ON disposal.household_id = account.household_id AND disposal.account_id = account.id
            )
             SELECT id, account_id, account_name, type, shares, unit_price_czk,
               proceeds_czk, occurred_at, note, can_edit, can_delete
            FROM movements
            ORDER BY occurred_at DESC, id DESC
            LIMIT 12
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var movements = new List<VwceMovementResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            movements.Add(new VwceMovementResponse(
                reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
                reader.GetDecimal(4), reader.IsDBNull(5) ? null : reader.GetDecimal(5),
                reader.IsDBNull(6) ? null : reader.GetDecimal(6), reader.GetDateTime(7),
                reader.IsDBNull(8) ? null : reader.GetString(8), reader.GetBoolean(9), reader.GetBoolean(10)));
        }
        return movements;
    }
}
