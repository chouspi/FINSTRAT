using System.Data;
using System.Text.Json;
using Finstrat.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Finstrat.Api.Modules.Bitcoin;

public sealed class BitcoinQueryService(ApplicationDbContext dbContext)
{
    public async Task<IReadOnlyList<BitcoinMovementResponse>> GetAccountMovementsAsync(
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
              FROM btc_accounts account
              WHERE account.household_id = @household_id AND account.id = @account_id
                AND account.archived_at IS NULL
                AND (
                  account.owner_user_id = @user_id
                  OR EXISTS (
                    SELECT 1 FROM btc_account_shares share
                    WHERE share.household_id = account.household_id
                      AND share.account_id = account.id AND share.user_id = @user_id
                  )
                )
            ), movements AS (
              SELECT lot.id, account.id AS account_id, account.name AS account_name,
                CASE WHEN lot.source_transfer_id IS NULL THEN 'purchase' ELSE 'internal_transfer_in' END AS type,
                lot.quantity_btc, lot.unit_price_czk, lot.acquired_at AS occurred_at, lot.txid, lot.note,
                lot.source_transfer_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM btc_lot_allocations allocation WHERE allocation.lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM btc_lots later WHERE later.account_id = lot.account_id AND (later.acquired_at, later.id) > (lot.acquired_at, lot.id))
                  AND NOT EXISTS (SELECT 1 FROM btc_disposals later WHERE later.account_id = lot.account_id AND later.disposed_at >= lot.acquired_at) AS can_edit,
                lot.source_transfer_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM btc_lot_allocations allocation WHERE allocation.lot_id = lot.id)
                  AND NOT EXISTS (SELECT 1 FROM btc_lots later WHERE later.account_id = lot.account_id AND (later.acquired_at, later.id) > (lot.acquired_at, lot.id))
                  AND NOT EXISTS (SELECT 1 FROM btc_disposals later WHERE later.account_id = lot.account_id AND later.disposed_at >= lot.acquired_at) AS can_delete
              FROM accessible_account account
              JOIN btc_lots lot ON lot.household_id = account.household_id AND lot.account_id = account.id
              UNION ALL
              SELECT disposal.id, account.id, account.name, disposal.kind,
                -disposal.quantity_btc, disposal.unit_price_czk, disposal.disposed_at,
                disposal.txid, disposal.note, false, false
              FROM accessible_account account
              JOIN btc_disposals disposal
                ON disposal.household_id = account.household_id AND disposal.account_id = account.id
            )
            SELECT id, account_id, account_name, type, quantity_btc, unit_price_czk,
              occurred_at, txid, note, can_edit, can_delete
            FROM movements ORDER BY occurred_at DESC, id DESC
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("account_id", accountId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var movements = new List<BitcoinMovementResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            movements.Add(new BitcoinMovementResponse(
                reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
                reader.GetDecimal(4), reader.IsDBNull(5) ? null : reader.GetDecimal(5),
                reader.GetDateTime(6), reader.IsDBNull(7) ? null : reader.GetString(7),
                reader.IsDBNull(8) ? null : reader.GetString(8), reader.GetBoolean(9), reader.GetBoolean(10)));
        }
        return movements;
    }

    public async Task<IReadOnlyList<BitcoinProofDetailResponse>> GetProofsAsync(
        Guid householdId,
        Guid userId,
        Guid accountId,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            SELECT p.id, p.content, p.content_size_bytes, p.sha256,
                   p.anchor_txid, p.anchored_at, p.note, p.created_at
            FROM ownership_proofs p
            JOIN btc_accounts a ON a.household_id = p.household_id AND a.id = p.account_id
            WHERE p.household_id = @household_id AND p.account_id = @account_id
              AND p.archived_at IS NULL AND a.archived_at IS NULL
              AND (
                a.owner_user_id = @user_id
                OR EXISTS (
                  SELECT 1 FROM btc_account_shares s
                  WHERE s.household_id = a.household_id
                    AND s.account_id = a.id AND s.user_id = @user_id
                )
              )
            ORDER BY p.created_at DESC, p.id DESC
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("account_id", accountId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var proofs = new List<BitcoinProofDetailResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            proofs.Add(new BitcoinProofDetailResponse(
                reader.GetGuid(0), reader.GetString(1), reader.GetInt64(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetDateTime(5),
                reader.IsDBNull(6) ? null : reader.GetString(6), reader.GetDateTime(7)));
        }
        return proofs;
    }

    public async Task<(string Content, string AccountName, DateTime CreatedAt)?> GetProofContentAsync(
        Guid householdId,
        Guid userId,
        Guid proofId,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            SELECT p.content, a.name, p.created_at
            FROM ownership_proofs p
            JOIN btc_accounts a ON a.household_id = p.household_id AND a.id = p.account_id
            WHERE p.household_id = @household_id AND p.id = @proof_id
              AND p.archived_at IS NULL AND a.archived_at IS NULL
              AND (
                a.owner_user_id = @user_id
                OR EXISTS (
                  SELECT 1 FROM btc_account_shares s
                  WHERE s.household_id = a.household_id
                    AND s.account_id = a.id AND s.user_id = @user_id
                )
              )
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("proof_id", proofId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? (reader.GetString(0), reader.GetString(1), reader.GetDateTime(2))
            : null;
    }

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
              GREATEST(lots.latest_at, disposals.latest_at) AS latest_activity_at,
              a.owner_user_id = @user_id AS is_owned_by_current_user,
              a.owner_user_id = @user_id OR EXISTS (
                SELECT 1
                FROM btc_account_shares managed_share
                JOIN users acting_user ON acting_user.id = managed_share.user_id
                WHERE managed_share.household_id = a.household_id
                  AND managed_share.account_id = a.id
                  AND managed_share.user_id = @user_id
                  AND acting_user.is_default
              ) AS can_manage,
              a.owner_user_id = @user_id AND NOT owner.is_default AS can_share_with_default,
              EXISTS (
                SELECT 1
                FROM btc_account_shares share
                JOIN users shared_user ON shared_user.id = share.user_id
                WHERE share.household_id = a.household_id
                  AND share.account_id = a.id
                  AND shared_user.is_default
              ) AS is_shared_with_default,
              COALESCE(proofs.items, '[]'::jsonb)::text AS proofs
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
              SELECT
                COUNT(*)::int AS proof_count,
                jsonb_agg(jsonb_build_object(
                  'id', p.id,
                  'note', p.note,
                  'sha256', p.sha256,
                  'createdAt', p.created_at,
                  'anchoredAt', p.anchored_at
                ) ORDER BY p.created_at DESC, p.id DESC) AS items
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
                reader.IsDBNull(10) ? null : reader.GetDateTime(10),
                reader.GetBoolean(11),
                reader.GetBoolean(12),
                reader.GetBoolean(13),
                reader.GetBoolean(14),
                JsonSerializer.Deserialize<List<BitcoinProofResponse>>(
                    reader.GetString(15), new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? []));
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
                l.note,
                false AS can_edit,
                false AS can_delete
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
                 d.note,
                 false AS can_edit,
                 false AS can_delete
              FROM accessible_accounts a
              JOIN btc_disposals d ON d.household_id = a.household_id AND d.account_id = a.id
            )
             SELECT id, account_id, account_name, type, quantity_btc, unit_price_czk, occurred_at, txid, note, can_edit, can_delete
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
                reader.IsDBNull(8) ? null : reader.GetString(8), reader.GetBoolean(9), reader.GetBoolean(10)));
        }
        return movements;
    }
}
