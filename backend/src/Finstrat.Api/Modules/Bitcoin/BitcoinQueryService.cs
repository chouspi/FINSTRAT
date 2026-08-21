using System.Data;
using Finstrat.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Finstrat.Api.Modules.Bitcoin;

public sealed class BitcoinQueryService(ApplicationDbContext dbContext)
{
    public async Task<BitcoinOverviewResponse> GetOverviewAsync(
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
            return new BitcoinOverviewResponse(
                new BitcoinTotalsResponse(
                    accounts.Sum(account => account.QuantityBtc),
                    accounts.Sum(account => account.CostBasisCzk),
                    accounts.Count,
                    accounts.All(account => account.CostBasisComplete)),
                accounts,
                movements);
        }
        finally
        {
            if (shouldClose) await connection.CloseAsync();
        }
    }

    private static async Task<List<BitcoinAccountResponse>> ReadAccountsAsync(
        NpgsqlConnection connection,
        Guid householdId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            WITH accessible_accounts AS (
              SELECT a.*
              FROM btc_accounts a
              WHERE a.household_id = @household_id
                AND a.archived_at IS NULL
                AND (
                  a.owner_user_id = @user_id
                  OR EXISTS (
                    SELECT 1 FROM btc_account_shares s
                    WHERE s.household_id = a.household_id
                      AND s.account_id = a.id
                      AND s.user_id = @user_id
                  )
                )
            )
            SELECT
              a.id,
              a.name,
              a.description,
              owner.display_name,
              COALESCE(lots.quantity_btc, 0) - COALESCE(disposals.quantity_btc, 0) AS quantity_btc,
              COALESCE(basis.cost_basis_czk, 0)::numeric(20,2) AS cost_basis_czk,
              COALESCE(basis.complete, true) AS cost_basis_complete,
              COALESCE(lots.lot_count, 0) AS lot_count,
              COALESCE(disposals.disposal_count, 0) AS disposal_count,
              COALESCE(proofs.proof_count, 0) AS proof_count,
              GREATEST(lots.latest_at, disposals.latest_at) AS latest_activity_at
            FROM accessible_accounts a
            JOIN users owner ON owner.id = a.owner_user_id
            LEFT JOIN LATERAL (
              SELECT SUM(l.quantity_btc) AS quantity_btc, COUNT(*)::int AS lot_count, MAX(l.acquired_at) AS latest_at
              FROM btc_lots l WHERE l.household_id = a.household_id AND l.account_id = a.id
            ) lots ON true
            LEFT JOIN LATERAL (
              SELECT SUM(d.quantity_btc) AS quantity_btc, COUNT(*)::int AS disposal_count, MAX(d.disposed_at) AS latest_at
              FROM btc_disposals d WHERE d.household_id = a.household_id AND d.account_id = a.id
            ) disposals ON true
            LEFT JOIN LATERAL (
              SELECT
                SUM(GREATEST(l.quantity_btc - COALESCE(allocated.quantity_btc, 0), 0) * l.unit_price_czk)
                  FILTER (WHERE l.unit_price_czk IS NOT NULL) AS cost_basis_czk,
                COALESCE(
                  BOOL_AND(l.unit_price_czk IS NOT NULL)
                    FILTER (WHERE l.quantity_btc - COALESCE(allocated.quantity_btc, 0) > 0),
                  true
                ) AS complete
              FROM btc_lots l
              LEFT JOIN LATERAL (
                SELECT SUM(allocation.quantity_btc) AS quantity_btc
                FROM btc_lot_allocations allocation
                WHERE allocation.household_id = l.household_id AND allocation.lot_id = l.id
              ) allocated ON true
              WHERE l.household_id = a.household_id AND l.account_id = a.id
            ) basis ON true
            LEFT JOIN LATERAL (
              SELECT COUNT(*)::int AS proof_count
              FROM ownership_proofs p
              WHERE p.household_id = a.household_id AND p.account_id = a.id AND p.archived_at IS NULL
            ) proofs ON true
            ORDER BY a.created_at, a.id
            """;

        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var accounts = new List<BitcoinAccountResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            accounts.Add(new BitcoinAccountResponse(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.GetString(3),
                reader.GetDecimal(4),
                reader.GetDecimal(5),
                reader.GetBoolean(6),
                reader.GetInt32(7),
                reader.GetInt32(8),
                reader.GetInt32(9),
                reader.IsDBNull(10) ? null : reader.GetDateTime(10)));
        }
        return accounts;
    }

    private static async Task<List<BitcoinMovementResponse>> ReadMovementsAsync(
        NpgsqlConnection connection,
        Guid householdId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            WITH accessible_accounts AS (
              SELECT a.id, a.household_id, a.name
              FROM btc_accounts a
              WHERE a.household_id = @household_id
                AND a.archived_at IS NULL
                AND (
                  a.owner_user_id = @user_id
                  OR EXISTS (
                    SELECT 1 FROM btc_account_shares s
                    WHERE s.household_id = a.household_id
                      AND s.account_id = a.id
                      AND s.user_id = @user_id
                  )
                )
            ), movements AS (
              SELECT
                l.id,
                a.id AS account_id,
                a.name AS account_name,
                CASE WHEN l.source_transfer_id IS NULL THEN 'purchase' ELSE 'internal_transfer_in' END AS type,
                l.quantity_btc,
                l.unit_price_czk,
                l.acquired_at AS occurred_at,
                l.txid,
                l.note
              FROM accessible_accounts a
              JOIN btc_lots l ON l.household_id = a.household_id AND l.account_id = a.id
              UNION ALL
              SELECT
                d.id,
                a.id AS account_id,
                a.name AS account_name,
                d.kind AS type,
                -d.quantity_btc AS quantity_btc,
                d.unit_price_czk,
                d.disposed_at AS occurred_at,
                d.txid,
                d.note
              FROM accessible_accounts a
              JOIN btc_disposals d ON d.household_id = a.household_id AND d.account_id = a.id
            )
            SELECT id, account_id, account_name, type, quantity_btc, unit_price_czk, occurred_at, txid, note
            FROM movements
            ORDER BY occurred_at DESC, id DESC
            LIMIT 12
            """;

        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var movements = new List<BitcoinMovementResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            movements.Add(new BitcoinMovementResponse(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetDecimal(4),
                reader.IsDBNull(5) ? null : reader.GetDecimal(5),
                reader.GetDateTime(6),
                reader.IsDBNull(7) ? null : reader.GetString(7),
                reader.IsDBNull(8) ? null : reader.GetString(8)));
        }
        return movements;
    }
}
