using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Finstrat.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Finstrat.Api.Modules.Bitcoin;

public sealed partial class BitcoinCommandService(ApplicationDbContext dbContext)
{
    public async Task<CreateBitcoinAccountResponse> CreateAccountAsync(
        Guid householdId,
        Guid userId,
        CreateBitcoinAccountRequest request,
        CancellationToken cancellationToken)
    {
        var name = request.Name.Trim();
        var description = NullIfWhiteSpace(request.Description);
        if (name.Length is < 1 or > 100) throw new BitcoinValidationException("Název účtu musí mít 1 až 100 znaků.");
        if (description?.Length > 500) throw new BitcoinValidationException("Popis účtu může mít nejvýše 500 znaků.");

        var id = Guid.NewGuid();
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand("""
                INSERT INTO btc_accounts (id, household_id, owner_user_id, name, description)
                VALUES (@id, @household_id, @user_id, @name, @description);

                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_account_created', 'btc_account', @id,
                  'Bitcoin account created'
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("id", id);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("name", name);
            command.Parameters.AddWithValue("description", (object?)description ?? DBNull.Value);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new CreateBitcoinAccountResponse(id, name, description);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw new BitcoinValidationException("Aktivní účet s tímto názvem už existuje.");
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<UpdateBitcoinAccountResponse> UpdateAccountAsync(
        Guid householdId,
        Guid userId,
        Guid accountId,
        UpdateBitcoinAccountRequest request,
        CancellationToken cancellationToken)
    {
        var name = request.Name.Trim();
        if (name.Length is < 1 or > 100) throw new BitcoinValidationException("Název účtu musí mít 1 až 100 znaků.");

        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand("""
                WITH updated AS (
                  UPDATE btc_accounts SET name = @name
                  WHERE household_id = @household_id AND id = @account_id
                    AND owner_user_id = @user_id AND archived_at IS NULL
                  RETURNING id
                ), audit AS (
                  INSERT INTO audit_events (
                    household_id, actor_user_id, event_type, entity_type, entity_id, description,
                    metadata
                  )
                  SELECT @household_id, @user_id, 'bitcoin_account_updated', 'btc_account', id,
                    'Bitcoin account updated', jsonb_build_object('name', @name)
                  FROM updated
                )
                SELECT id FROM updated
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("account_id", accountId);
            command.Parameters.AddWithValue("name", name);
            if (await command.ExecuteScalarAsync(cancellationToken) is null)
                throw new BitcoinValidationException("Účet nebyl nalezen nebo jej může upravit pouze vlastník.");

            await transaction.CommitAsync(cancellationToken);
            return new UpdateBitcoinAccountResponse(accountId, name);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw new BitcoinValidationException("Aktivní účet s tímto názvem už existuje.");
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task ArchiveAccountAsync(
        Guid householdId,
        Guid userId,
        Guid accountId,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            WITH invalidated AS (
              DELETE FROM btc_strategy_states state
              USING btc_lots lot
              WHERE state.household_id = @household_id AND state.owner_user_id = @user_id
                AND lot.household_id = state.household_id AND lot.account_id = @account_id
                AND lot.created_at <= state.activated_at
              RETURNING state.owner_user_id
            ), archived AS (
              UPDATE btc_accounts SET archived_at = now()
              WHERE household_id = @household_id AND id = @account_id
                AND owner_user_id = @user_id AND archived_at IS NULL
              RETURNING id
            )
            INSERT INTO audit_events (
              household_id, actor_user_id, event_type, entity_type, entity_id, description
            )
            SELECT @household_id, @user_id, 'bitcoin_account_archived', 'btc_account', id,
              'Bitcoin account archived'
            FROM archived
            RETURNING entity_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("account_id", accountId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new BitcoinValidationException("Účet nebyl nalezen nebo jej může odstranit pouze vlastník.");
    }

    public async Task UpdatePurchaseMovementAsync(
        Guid householdId, Guid userId, Guid movementId,
        UpdateBitcoinPurchaseMovementRequest request, CancellationToken cancellationToken)
    {
        var quantity = ParseQuantity(request.QuantityBtc, "Množství");
        if (quantity <= 0) throw new BitcoinValidationException("Množství musí být kladné.");
        if (!decimal.TryParse(request.UnitPriceCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out var unitPriceCzk)
            || unitPriceCzk <= 0) throw new BitcoinValidationException("Cena za BTC musí být kladné číslo.");
        var acquiredAt = ParseDate(request.AcquiredAt, "Datum nákupu");
        var txid = ParseTxid(request.Txid);
        var note = ParseNote(request.Note);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await EnsureEditablePurchaseAsync(connection, transaction, householdId, userId, movementId, cancellationToken);
            await using var command = new NpgsqlCommand("""
                DELETE FROM btc_strategy_states state
                USING btc_lots lot, btc_accounts account
                WHERE state.household_id = @household_id AND state.owner_user_id = @user_id
                  AND lot.household_id = state.household_id AND lot.id = @movement_id
                  AND account.household_id = lot.household_id AND account.id = lot.account_id
                  AND account.owner_user_id = state.owner_user_id
                  AND lot.created_at <= state.activated_at;
                UPDATE btc_lots SET quantity_btc = @quantity, unit_price_czk = @unit_price_czk,
                  acquired_at = @acquired_at, tax_acquired_at = @acquired_at, txid = @txid, note = @note
                WHERE household_id = @household_id AND id = @movement_id;
                UPDATE checkpoint_adjustments SET
                  adjustment_czk = round(@quantity * @unit_price_czk, 2), effective_at = @acquired_at
                WHERE household_id = @household_id AND source_entity_type = 'btc_lot'
                  AND source_entity_id = @movement_id;
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_purchase_updated', 'btc_lot', @movement_id,
                  'Bitcoin purchase updated'
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("movement_id", movementId);
            command.Parameters.AddWithValue("quantity", quantity);
            command.Parameters.AddWithValue("unit_price_czk", unitPriceCzk);
            command.Parameters.AddWithValue("acquired_at", acquiredAt);
            command.Parameters.AddWithValue("txid", (object?)txid ?? DBNull.Value);
            command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task DeletePurchaseMovementAsync(
        Guid householdId, Guid userId, Guid movementId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await EnsureEditablePurchaseAsync(connection, transaction, householdId, userId, movementId, cancellationToken);
            await using var command = new NpgsqlCommand("""
                DELETE FROM btc_strategy_states state
                USING btc_lots lot, btc_accounts account
                WHERE state.household_id = @household_id AND state.owner_user_id = @user_id
                  AND lot.household_id = state.household_id AND lot.id = @movement_id
                  AND account.household_id = lot.household_id AND account.id = lot.account_id
                  AND account.owner_user_id = state.owner_user_id
                  AND lot.created_at <= state.activated_at;
                DELETE FROM checkpoint_adjustments
                WHERE household_id = @household_id AND source_entity_type = 'btc_lot'
                  AND source_entity_id = @movement_id;
                DELETE FROM btc_lots WHERE household_id = @household_id AND id = @movement_id;
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_purchase_deleted', 'btc_lot', @movement_id,
                  'Bitcoin purchase deleted'
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("movement_id", movementId);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private static async Task EnsureEditablePurchaseAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId,
        Guid userId, Guid movementId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT 1 FROM btc_lots lot
            JOIN btc_accounts account ON account.household_id = lot.household_id AND account.id = lot.account_id
            WHERE lot.household_id = @household_id AND lot.id = @movement_id
              AND account.archived_at IS NULL AND lot.source_transfer_id IS NULL
              AND (
                account.owner_user_id = @user_id
                OR EXISTS (
                  SELECT 1 FROM btc_account_shares share
                  JOIN users acting_user ON acting_user.id = share.user_id
                  WHERE share.household_id = account.household_id AND share.account_id = account.id
                    AND share.user_id = @user_id AND acting_user.is_default
                )
              )
              AND NOT EXISTS (SELECT 1 FROM btc_lot_allocations allocation WHERE allocation.lot_id = lot.id)
              AND NOT EXISTS (SELECT 1 FROM btc_lots later WHERE later.account_id = lot.account_id AND (later.acquired_at, later.id) > (lot.acquired_at, lot.id))
              AND NOT EXISTS (SELECT 1 FROM btc_disposals later WHERE later.account_id = lot.account_id AND later.disposed_at >= lot.acquired_at)
            FOR UPDATE OF lot
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("movement_id", movementId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new BitcoinValidationException("Pohyb nelze upravit ani odstranit, protože na něj navazuje další účetní pohyb.");
    }

    public async Task SetDefaultSharingAsync(
        Guid householdId,
        Guid userId,
        Guid accountId,
        bool shared,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using var targetCommand = new NpgsqlCommand("""
                SELECT default_user.id
                FROM btc_accounts account
                JOIN household_members default_member ON default_member.household_id = account.household_id
                JOIN users default_user ON default_user.id = default_member.user_id AND default_user.is_default
                WHERE account.household_id = @household_id
                  AND account.id = @account_id
                  AND account.owner_user_id = @user_id
                  AND account.archived_at IS NULL
                  AND default_user.id <> @user_id
                FOR UPDATE OF account
                """, connection, transaction);
            targetCommand.Parameters.AddWithValue("household_id", householdId);
            targetCommand.Parameters.AddWithValue("account_id", accountId);
            targetCommand.Parameters.AddWithValue("user_id", userId);
            var defaultUserId = await targetCommand.ExecuteScalarAsync(cancellationToken) as Guid?;
            if (defaultUserId is null)
            {
                throw new BitcoinValidationException("Sdílení může změnit pouze vlastník účtu, který není defaultním uživatelem.");
            }

            var sql = shared
                ? """
                  INSERT INTO btc_account_shares (household_id, account_id, user_id, created_by)
                  VALUES (@household_id, @account_id, @default_user_id, @user_id)
                  ON CONFLICT (account_id, user_id) DO NOTHING;
                  """
                : """
                  DELETE FROM btc_account_shares
                  WHERE household_id = @household_id
                    AND account_id = @account_id
                    AND user_id = @default_user_id;
                  """;
            await using var shareCommand = new NpgsqlCommand(sql + """

                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description, metadata
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_account_default_sharing_changed',
                  'btc_account', @account_id, 'Bitcoin account default sharing changed',
                  jsonb_build_object('shared', @shared)
                );
                """, connection, transaction);
            shareCommand.Parameters.AddWithValue("household_id", householdId);
            shareCommand.Parameters.AddWithValue("account_id", accountId);
            shareCommand.Parameters.AddWithValue("default_user_id", defaultUserId.Value);
            shareCommand.Parameters.AddWithValue("user_id", userId);
            shareCommand.Parameters.AddWithValue("shared", shared);
            await shareCommand.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<BitcoinProofDetailResponse> CreateProofAsync(
        Guid householdId,
        Guid userId,
        Guid accountId,
        SaveBitcoinProofRequest request,
        CancellationToken cancellationToken)
    {
        var proof = ValidateProof(request);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await EnsureOwnedAccountAsync(connection, transaction, householdId, userId, accountId, cancellationToken);
            var id = Guid.NewGuid();
            var createdAt = DateTime.UtcNow;
            await using var command = new NpgsqlCommand("""
                INSERT INTO ownership_proofs (
                  id, household_id, account_id, account_name_snapshot, content,
                  content_size_bytes, sha256, anchor_txid, anchored_at, note, created_at, created_by
                )
                SELECT @id, @household_id, account.id, account.name, @content,
                  @content_size_bytes, @sha256, @anchor_txid, @anchored_at, @note, @created_at, @user_id
                FROM btc_accounts account
                WHERE account.household_id = @household_id AND account.id = @account_id;

                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_proof_created', 'ownership_proof', @id,
                  'Bitcoin ownership proof created'
                );
                """, connection, transaction);
            AddProofParameters(command, householdId, userId, accountId, id, createdAt, proof);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new BitcoinProofDetailResponse(
                id, proof.Content, proof.ContentSizeBytes, proof.Sha256,
                proof.AnchorTxid, proof.AnchoredAt, proof.Note, createdAt);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw new BitcoinValidationException("Doklad se stejným SHA-256 již existuje.");
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<BitcoinProofDetailResponse> UpdateProofAsync(
        Guid householdId,
        Guid userId,
        Guid proofId,
        SaveBitcoinProofRequest request,
        CancellationToken cancellationToken)
    {
        var proof = ValidateProof(request);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using var lockCommand = new NpgsqlCommand("""
                SELECT p.anchor_txid, p.created_at
                FROM ownership_proofs p
                JOIN btc_accounts a ON a.household_id = p.household_id AND a.id = p.account_id
                WHERE p.household_id = @household_id AND p.id = @proof_id
                  AND p.archived_at IS NULL
                  AND (
                    a.owner_user_id = @user_id
                    OR EXISTS (
                      SELECT 1 FROM btc_account_shares share
                      JOIN users acting_user ON acting_user.id = share.user_id
                      WHERE share.household_id = a.household_id AND share.account_id = a.id
                        AND share.user_id = @user_id AND acting_user.is_default
                    )
                  )
                FOR UPDATE OF p
                """, connection, transaction);
            lockCommand.Parameters.AddWithValue("household_id", householdId);
            lockCommand.Parameters.AddWithValue("proof_id", proofId);
            lockCommand.Parameters.AddWithValue("user_id", userId);
            await using var reader = await lockCommand.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
                throw new BitcoinValidationException("Doklad nebyl nalezen nebo jej aktuální uživatel nevlastní.");
            if (!reader.IsDBNull(0))
                throw new BitcoinValidationException("Ukotvený doklad je neměnný a lze jej pouze archivovat.");
            var createdAt = reader.GetDateTime(1);
            await reader.DisposeAsync();

            await using var command = new NpgsqlCommand("""
                UPDATE ownership_proofs SET
                  content = @content, content_size_bytes = @content_size_bytes, sha256 = @sha256,
                  anchor_txid = @anchor_txid, anchored_at = @anchored_at, note = @note
                WHERE household_id = @household_id AND id = @proof_id;
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_proof_updated', 'ownership_proof', @proof_id,
                  'Bitcoin ownership proof updated'
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("proof_id", proofId);
            command.Parameters.AddWithValue("user_id", userId);
            AddProofValueParameters(command, proof);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new BitcoinProofDetailResponse(
                proofId, proof.Content, proof.ContentSizeBytes, proof.Sha256,
                proof.AnchorTxid, proof.AnchoredAt, proof.Note, createdAt);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw new BitcoinValidationException("Doklad se stejným SHA-256 již existuje.");
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task ArchiveProofAsync(
        Guid householdId,
        Guid userId,
        Guid proofId,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            WITH archived AS (
              UPDATE ownership_proofs p SET archived_at = now()
              FROM btc_accounts a
              WHERE p.household_id = @household_id AND p.id = @proof_id
                AND p.archived_at IS NULL
                AND a.household_id = p.household_id AND a.id = p.account_id
                AND (
                  a.owner_user_id = @user_id
                  OR EXISTS (
                    SELECT 1 FROM btc_account_shares share
                    JOIN users acting_user ON acting_user.id = share.user_id
                    WHERE share.household_id = a.household_id AND share.account_id = a.id
                      AND share.user_id = @user_id AND acting_user.is_default
                  )
                )
              RETURNING p.id
            )
            INSERT INTO audit_events (
              household_id, actor_user_id, event_type, entity_type, entity_id, description
            )
            SELECT @household_id, @user_id, 'bitcoin_proof_archived', 'ownership_proof', id,
              'Bitcoin ownership proof archived'
            FROM archived
            RETURNING entity_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("proof_id", proofId);
        command.Parameters.AddWithValue("user_id", userId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new BitcoinValidationException("Doklad nebyl nalezen nebo jej aktuální uživatel nevlastní.");
    }

    public async Task<CreateBitcoinTransferResponse> CreateTransferAsync(
        Guid householdId,
        Guid userId,
        Guid idempotencyKey,
        CreateBitcoinTransferRequest request,
        CancellationToken cancellationToken)
    {
        var gross = ParseQuantity(request.GrossQuantityBtc, "Převáděné množství");
        var fee = string.IsNullOrWhiteSpace(request.FeeQuantityBtc)
            ? 0m
            : ParseQuantity(request.FeeQuantityBtc, "Poplatek");
        if (gross <= 0) throw new BitcoinValidationException("Převáděné množství musí být kladné.");
        if (fee < 0 || fee >= gross) throw new BitcoinValidationException("Poplatek musí být nezáporný a menší než převáděné množství.");
        if (request.FromAccountId == request.ToAccountId) throw new BitcoinValidationException("Zdrojový a cílový účet musí být rozdílný.");
        if (!DateTimeOffset.TryParse(request.TransferredAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsedAt))
        {
            throw new BitcoinValidationException("Datum převodu není platné.");
        }
        var transferredAt = parsedAt.UtcDateTime;
        if (transferredAt.Date > DateTime.UtcNow.Date) throw new BitcoinValidationException("Převod nemůže být v budoucnosti.");
        var txid = NullIfWhiteSpace(request.Txid)?.ToLowerInvariant();
        if (txid is not null && !TxidPattern().IsMatch(txid)) throw new BitcoinValidationException("TXID musí obsahovat 64 hexadecimálních znaků.");
        var note = NullIfWhiteSpace(request.Note);
        if (note?.Length > 500) throw new BitcoinValidationException("Poznámka může mít nejvýše 500 znaků.");

        var net = gross - fee;
        var requestHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request))));
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var replay = await RegisterIdempotencyAsync<CreateBitcoinTransferResponse>(
                connection, transaction, householdId, idempotencyKey, requestHash, cancellationToken);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken);
                return replay;
            }

            var accounts = await LockAccountsAsync(
                connection, transaction, householdId, userId,
                request.FromAccountId, request.ToAccountId, cancellationToken);
            if (accounts.Count != 2) throw new BitcoinValidationException("Zdrojový nebo cílový účet nebyl nalezen.");
            if (accounts.Values.Distinct().Count() != 1)
                throw new BitcoinValidationException("BTC lze převádět pouze mezi účty stejného vlastníka.");

            var latestActivity = await LatestActivityAsync(
                connection, transaction, householdId, request.FromAccountId, cancellationToken);
            if (latestActivity is not null && transferredAt < latestActivity)
            {
                throw new BitcoinValidationException("Převod nelze vložit před novější pohyb na zdrojovém účtu.");
            }

            var chunks = await AllocateLotsAsync(
                connection, transaction, householdId, request.FromAccountId,
                gross, transferredAt, cancellationToken);
            var transferId = Guid.NewGuid();
            var disposalId = Guid.NewGuid();
            await InsertTransferAndDisposalAsync(
                connection, transaction, householdId, userId, transferId, disposalId,
                request, gross, fee, transferredAt, txid, note, cancellationToken);

            var receivedSoFar = 0m;
            for (var index = 0; index < chunks.Count; index++)
            {
                var chunk = chunks[index];
                var received = index == chunks.Count - 1
                    ? net - receivedSoFar
                    : decimal.Round(chunk.QuantityBtc * net / gross, 8, MidpointRounding.ToEven);
                receivedSoFar += received;
                await InsertAllocationAndDestinationLotAsync(
                    connection, transaction, householdId, userId, transferId, disposalId,
                    request.ToAccountId, chunk, received, transferredAt, txid, cancellationToken);
            }

            var response = new CreateBitcoinTransferResponse(
                transferId, request.FromAccountId, request.ToAccountId,
                gross, fee, net, transferredAt);
            await CompleteIdempotencyAsync(
                connection, transaction, householdId, idempotencyKey, response, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return response;
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<CreateBitcoinPurchaseResponse> CreatePurchaseAsync(
        Guid householdId,
        Guid userId,
        Guid idempotencyKey,
        CreateBitcoinPurchaseRequest request,
        CancellationToken cancellationToken)
    {
        var quantity = ParseQuantity(request.QuantityBtc, "Množství");
        if (quantity <= 0) throw new BitcoinValidationException("Množství musí být kladné.");
        if (!decimal.TryParse(request.UnitPriceCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out var unitPriceCzk)
            || unitPriceCzk <= 0) throw new BitcoinValidationException("Cena za BTC musí být kladné číslo.");
        var acquiredAt = ParseDate(request.AcquiredAt, "Datum nákupu");
        var txid = ParseTxid(request.Txid);
        var note = ParseNote(request.Note);
        var requestHash = RequestHash(request);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            var replay = await RegisterIdempotencyAsync<CreateBitcoinPurchaseResponse>(
                connection, transaction, householdId, idempotencyKey, requestHash, cancellationToken);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken);
                return replay;
            }
            await EnsureOwnedAccountAsync(connection, transaction, householdId, userId, request.AccountId, cancellationToken);
            var id = Guid.NewGuid();
            await using var command = new NpgsqlCommand("""
                INSERT INTO btc_lots (
                  id, household_id, account_id, quantity_btc, unit_price_czk,
                  acquired_at, tax_acquired_at, txid, note, created_by
                ) VALUES (
                  @id, @household_id, @account_id, @quantity, @unit_price_czk,
                  @acquired_at, @acquired_at, @txid, @note, @user_id
                );
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_purchase_created', 'btc_lot', @id, 'Bitcoin purchase created'
                );
                INSERT INTO checkpoint_adjustments (
                  household_id, checkpoint_id, adjustment_czk, reason, effective_at,
                  source_entity_type, source_entity_id, created_by
                )
                SELECT @household_id, checkpoint.id, round(@quantity * @unit_price_czk, 2),
                  'btc_purchase', @acquired_at, 'btc_lot', @id, @user_id
                FROM strategy_checkpoints checkpoint
                WHERE checkpoint.household_id = @household_id AND checkpoint.status = 'active';
                """, connection, transaction);
            command.Parameters.AddWithValue("id", id);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("account_id", request.AccountId);
            command.Parameters.AddWithValue("quantity", quantity);
            command.Parameters.AddWithValue("unit_price_czk", unitPriceCzk);
            command.Parameters.AddWithValue("acquired_at", acquiredAt);
            command.Parameters.AddWithValue("txid", (object?)txid ?? DBNull.Value);
            command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
            command.Parameters.AddWithValue("user_id", userId);
            await command.ExecuteNonQueryAsync(cancellationToken);
            var response = new CreateBitcoinPurchaseResponse(id, request.AccountId, quantity, unitPriceCzk, acquiredAt);
            await CompleteIdempotencyAsync(connection, transaction, householdId, idempotencyKey, response, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return response;
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<CreateBitcoinWithdrawalResponse> CreateWithdrawalAsync(
        Guid householdId,
        Guid userId,
        Guid idempotencyKey,
        CreateBitcoinWithdrawalRequest request,
        CancellationToken cancellationToken)
    {
        var quantity = ParseQuantity(request.QuantityBtc, "Množství");
        if (quantity <= 0) throw new BitcoinValidationException("Množství musí být kladné.");
        decimal? unitPriceCzk = null;
        if (!string.IsNullOrWhiteSpace(request.UnitPriceCzk))
        {
            if (!decimal.TryParse(request.UnitPriceCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out var parsedPrice)
                || parsedPrice <= 0) throw new BitcoinValidationException("Cena za BTC musí být kladné číslo.");
            unitPriceCzk = parsedPrice;
        }
        var withdrawnAt = ParseDate(request.WithdrawnAt, "Datum výběru");
        var txid = ParseTxid(request.Txid);
        var note = ParseNote(request.Note);
        var purpose = string.IsNullOrWhiteSpace(request.Purpose) ? "standalone" : request.Purpose.Trim();
        if (purpose is not ("standalone" or "life_expense"))
            throw new BitcoinValidationException("Účel výběru není podporovaný.");
        string? expenseCategory = null;
        if (purpose == "life_expense")
        {
            if (unitPriceCzk is null) throw new BitcoinValidationException("Životní výdaj vyžaduje aktuální cenu BTC.");
            expenseCategory = NullIfWhiteSpace(request.LifeExpenseCategory);
            if (expenseCategory is not ("auto" or "hypotéka" or "bydlení" or "vzdělání" or "zdraví" or "nouzové výdaje"))
                throw new BitcoinValidationException("Vyberte platnou kategorii životního výdaje.");
        }
        var requestHash = RequestHash(request);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var replay = await RegisterIdempotencyAsync<CreateBitcoinWithdrawalResponse>(
                connection, transaction, householdId, idempotencyKey, requestHash, cancellationToken);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken);
                return replay;
            }
            await EnsureOwnedAccountAsync(connection, transaction, householdId, userId, request.AccountId, cancellationToken);
            var latestActivity = await LatestActivityAsync(connection, transaction, householdId, request.AccountId, cancellationToken);
            if (latestActivity is not null && withdrawnAt < latestActivity)
                throw new BitcoinValidationException("Výběr nelze vložit před novější pohyb na účtu.");
            var chunks = await AllocateLotsAsync(connection, transaction, householdId, request.AccountId, quantity, withdrawnAt, cancellationToken);
            var id = Guid.NewGuid();
            var lifeExpenseId = purpose == "life_expense" ? Guid.NewGuid() : (Guid?)null;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO life_expenses (
                  id, household_id, amount_czk, category, note, spent_at, created_by
                )
                SELECT @life_expense_id, @household_id, round(@quantity * @unit_price_czk, 2),
                  @expense_category, @note, @withdrawn_at, @user_id
                WHERE @kind = 'life_expense';

                INSERT INTO btc_disposals (
                  id, household_id, account_id, kind, quantity_btc, unit_price_czk,
                  disposed_at, txid, note, life_expense_id, created_by
                ) VALUES (
                  @id, @household_id, @account_id, @kind, @quantity, @unit_price_czk,
                  @withdrawn_at, @txid, @note, @life_expense_id, @user_id
                );
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'bitcoin_withdrawal_created', 'btc_disposal', @id, 'Bitcoin withdrawal created'
                );
                INSERT INTO checkpoint_adjustments (
                  household_id, checkpoint_id, adjustment_czk, reason, effective_at,
                  source_entity_type, source_entity_id, created_by
                )
                SELECT @household_id, checkpoint.id, -round(@quantity * @unit_price_czk, 2),
                  'life_expense', @withdrawn_at, 'life_expense', @life_expense_id, @user_id
                FROM strategy_checkpoints checkpoint
                WHERE checkpoint.household_id = @household_id
                  AND checkpoint.status = 'active' AND @kind = 'life_expense';
                """, connection, transaction))
            {
                command.Parameters.AddWithValue("id", id);
                command.Parameters.AddWithValue("household_id", householdId);
                command.Parameters.AddWithValue("account_id", request.AccountId);
                command.Parameters.AddWithValue("quantity", quantity);
                command.Parameters.AddWithValue("unit_price_czk", NpgsqlDbType.Numeric, (object?)unitPriceCzk ?? DBNull.Value);
                command.Parameters.AddWithValue("kind", purpose);
                command.Parameters.AddWithValue("life_expense_id", NpgsqlDbType.Uuid, (object?)lifeExpenseId ?? DBNull.Value);
                command.Parameters.AddWithValue("expense_category", (object?)expenseCategory ?? DBNull.Value);
                command.Parameters.AddWithValue("withdrawn_at", withdrawnAt);
                command.Parameters.AddWithValue("txid", (object?)txid ?? DBNull.Value);
                command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
                command.Parameters.AddWithValue("user_id", userId);
                await command.ExecuteNonQueryAsync(cancellationToken);
            }
            foreach (var chunk in chunks)
            {
                await using var allocation = new NpgsqlCommand("""
                    INSERT INTO btc_lot_allocations (
                      household_id, disposal_id, lot_id, quantity_btc, cost_basis_czk
                    ) VALUES (
                      @household_id, @disposal_id, @lot_id, @quantity,
                      CASE WHEN @unit_price_czk IS NULL THEN NULL ELSE round(@quantity * @unit_price_czk, 2) END
                    )
                    """, connection, transaction);
                allocation.Parameters.AddWithValue("household_id", householdId);
                allocation.Parameters.AddWithValue("disposal_id", id);
                allocation.Parameters.AddWithValue("lot_id", chunk.LotId);
                allocation.Parameters.AddWithValue("quantity", chunk.QuantityBtc);
                allocation.Parameters.AddWithValue("unit_price_czk", NpgsqlDbType.Numeric, (object?)chunk.UnitPriceCzk ?? DBNull.Value);
                await allocation.ExecuteNonQueryAsync(cancellationToken);
            }
            var response = new CreateBitcoinWithdrawalResponse(id, request.AccountId, quantity, unitPriceCzk, withdrawnAt);
            await CompleteIdempotencyAsync(connection, transaction, householdId, idempotencyKey, response, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return response;
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private static async Task<T?> RegisterIdempotencyAsync<T>(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid key,
        string requestHash,
        CancellationToken cancellationToken) where T : class
    {
        await using var insert = new NpgsqlCommand("""
            INSERT INTO idempotency_keys (household_id, key, request_hash, expires_at)
            VALUES (@household_id, @key, @request_hash, now() + interval '24 hours')
            ON CONFLICT (household_id, key) DO NOTHING
            """, connection, transaction);
        insert.Parameters.AddWithValue("household_id", householdId);
        insert.Parameters.AddWithValue("key", key);
        insert.Parameters.AddWithValue("request_hash", requestHash);
        if (await insert.ExecuteNonQueryAsync(cancellationToken) == 1) return null;

        await using var select = new NpgsqlCommand("""
            SELECT request_hash, response_body FROM idempotency_keys
            WHERE household_id = @household_id AND key = @key
            """, connection, transaction);
        select.Parameters.AddWithValue("household_id", householdId);
        select.Parameters.AddWithValue("key", key);
        await using var reader = await select.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) throw new InvalidOperationException("Idempotency record disappeared.");
        if (reader.GetString(0) != requestHash) throw new BitcoinValidationException("Idempotency key už byl použit pro jiný požadavek.");
        if (reader.IsDBNull(1)) throw new BitcoinValidationException("Stejný převod se právě zpracovává.");
        return JsonSerializer.Deserialize<T>(reader.GetString(1))
            ?? throw new InvalidOperationException("Stored idempotency response is invalid.");
    }

    private static async Task<Dictionary<Guid, Guid>> LockAccountsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid userId,
        Guid fromAccountId,
        Guid toAccountId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT account.id, account.owner_user_id FROM btc_accounts account
            WHERE account.household_id = @household_id
              AND account.archived_at IS NULL
              AND account.id IN (@from_account_id, @to_account_id)
              AND (
                account.owner_user_id = @user_id
                OR EXISTS (
                  SELECT 1 FROM btc_account_shares share
                  JOIN users acting_user ON acting_user.id = share.user_id
                  WHERE share.household_id = account.household_id AND share.account_id = account.id
                    AND share.user_id = @user_id AND acting_user.is_default
                )
              )
            ORDER BY account.id
            FOR UPDATE OF account
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("from_account_id", fromAccountId);
        command.Parameters.AddWithValue("to_account_id", toAccountId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var result = new Dictionary<Guid, Guid>();
        while (await reader.ReadAsync(cancellationToken)) result.Add(reader.GetGuid(0), reader.GetGuid(1));
        return result;
    }

    private static async Task<DateTime?> LatestActivityAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid accountId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT MAX(occurred_at) FROM (
              SELECT acquired_at AS occurred_at FROM btc_lots
              WHERE household_id = @household_id AND account_id = @account_id
              UNION ALL
              SELECT disposed_at FROM btc_disposals
              WHERE household_id = @household_id AND account_id = @account_id
            ) activity
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("account_id", accountId);
        return await command.ExecuteScalarAsync(cancellationToken) as DateTime?;
    }

    private static async Task<List<TransferChunk>> AllocateLotsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid accountId,
        decimal gross,
        DateTime transferredAt,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT
              l.id,
              l.unit_price_czk,
              l.quantity_btc - COALESCE(allocated.quantity_btc, 0) AS remaining_btc
            FROM btc_lots l
            LEFT JOIN LATERAL (
              SELECT SUM(a.quantity_btc) AS quantity_btc
              FROM btc_lot_allocations a
              WHERE a.household_id = l.household_id AND a.lot_id = l.id
            ) allocated ON true
            WHERE l.household_id = @household_id
              AND l.account_id = @account_id
              AND l.acquired_at <= @transferred_at
              AND l.quantity_btc - COALESCE(allocated.quantity_btc, 0) > 0
            ORDER BY l.acquired_at, l.id
            FOR UPDATE OF l
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("account_id", accountId);
        command.Parameters.AddWithValue("transferred_at", transferredAt);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var remaining = gross;
        var chunks = new List<TransferChunk>();
        while (remaining > 0 && await reader.ReadAsync(cancellationToken))
        {
            var available = reader.GetDecimal(2);
            var quantity = decimal.Min(available, remaining);
            chunks.Add(new TransferChunk(
                reader.GetGuid(0),
                reader.IsDBNull(1) ? null : reader.GetDecimal(1),
                quantity));
            remaining -= quantity;
        }
        if (remaining > 0) throw new BitcoinValidationException($"Na zdrojovém účtu chybí {remaining:0.00000000} BTC.");
        return chunks;
    }

    private static async Task InsertTransferAndDisposalAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid userId,
        Guid transferId,
        Guid disposalId,
        CreateBitcoinTransferRequest request,
        decimal gross,
        decimal fee,
        DateTime transferredAt,
        string? txid,
        string? note,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            INSERT INTO btc_transfers (
              id, household_id, from_account_id, to_account_id,
              gross_quantity_btc, fee_quantity_btc, transferred_at, txid, note, created_by
            ) VALUES (
              @transfer_id, @household_id, @from_account_id, @to_account_id,
              @gross, @fee, @transferred_at, @txid, @note, @user_id
            );

            INSERT INTO btc_disposals (
              id, household_id, account_id, kind, quantity_btc,
              disposed_at, txid, note, transfer_id, created_by
            ) VALUES (
              @disposal_id, @household_id, @from_account_id, 'internal_transfer', @gross,
              @transferred_at, @txid, @note, @transfer_id, @user_id
            );

            INSERT INTO audit_events (
              household_id, actor_user_id, event_type, entity_type, entity_id,
              description, metadata
            ) VALUES (
              @household_id, @user_id, 'bitcoin_transfer_created', 'btc_transfer', @transfer_id,
              'Bitcoin internal transfer created',
              jsonb_build_object('gross_btc', @gross, 'fee_btc', @fee)
            );
            """, connection, transaction);
        command.Parameters.AddWithValue("transfer_id", transferId);
        command.Parameters.AddWithValue("disposal_id", disposalId);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("from_account_id", request.FromAccountId);
        command.Parameters.AddWithValue("to_account_id", request.ToAccountId);
        command.Parameters.AddWithValue("gross", gross);
        command.Parameters.AddWithValue("fee", fee);
        command.Parameters.AddWithValue("transferred_at", transferredAt);
        command.Parameters.AddWithValue("txid", (object?)txid ?? DBNull.Value);
        command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task InsertAllocationAndDestinationLotAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid userId,
        Guid transferId,
        Guid disposalId,
        Guid destinationAccountId,
        TransferChunk chunk,
        decimal received,
        DateTime transferredAt,
        string? txid,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            INSERT INTO btc_lot_allocations (
              household_id, disposal_id, lot_id, quantity_btc, cost_basis_czk
            ) VALUES (
              @household_id, @disposal_id, @source_lot_id, @source_quantity,
              CASE WHEN @unit_price_czk IS NULL THEN NULL ELSE round(@source_quantity * @unit_price_czk, 2) END
            );

            INSERT INTO btc_lots (
              household_id, account_id, quantity_btc, unit_price_czk,
              acquired_at, tax_acquired_at, txid, note,
              source_transfer_id, source_lot_id, created_by
            ) VALUES (
              @household_id, @destination_account_id, @received, @unit_price_czk,
              @transferred_at, @transferred_at, @txid, 'Interní převod',
              @transfer_id, @source_lot_id, @user_id
            );
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("transfer_id", transferId);
        command.Parameters.AddWithValue("disposal_id", disposalId);
        command.Parameters.AddWithValue("source_lot_id", chunk.LotId);
        command.Parameters.AddWithValue("destination_account_id", destinationAccountId);
        command.Parameters.AddWithValue("source_quantity", chunk.QuantityBtc);
        command.Parameters.AddWithValue("received", received);
        command.Parameters.AddWithValue("unit_price_czk", NpgsqlDbType.Numeric, (object?)chunk.UnitPriceCzk ?? DBNull.Value);
        command.Parameters.AddWithValue("transferred_at", transferredAt);
        command.Parameters.AddWithValue("txid", (object?)txid ?? DBNull.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task CompleteIdempotencyAsync<T>(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid key,
        T response,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            UPDATE idempotency_keys
            SET response_status = 201, response_body = @response_body
            WHERE household_id = @household_id AND key = @key
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("key", key);
        command.Parameters.AddWithValue("response_body", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(response));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static decimal ParseQuantity(string value, string field)
    {
        if (!decimal.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out var quantity))
        {
            throw new BitcoinValidationException($"{field} není platné číslo.");
        }
        var scale = (decimal.GetBits(quantity)[3] >> 16) & 0x7F;
        if (scale > 8) throw new BitcoinValidationException($"{field} může mít nejvýše 8 desetinných míst.");
        return quantity;
    }

    private static async Task EnsureOwnedAccountAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid householdId,
        Guid userId,
        Guid accountId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT 1 FROM btc_accounts account
            WHERE account.household_id = @household_id AND account.id = @account_id
              AND account.archived_at IS NULL
              AND (
                account.owner_user_id = @user_id
                OR EXISTS (
                  SELECT 1 FROM btc_account_shares share
                  JOIN users acting_user ON acting_user.id = share.user_id
                  WHERE share.household_id = account.household_id AND share.account_id = account.id
                    AND share.user_id = @user_id AND acting_user.is_default
                )
              )
            FOR UPDATE OF account
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("account_id", accountId);
        command.Parameters.AddWithValue("user_id", userId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new BitcoinValidationException("Účet nebyl nalezen nebo k němu aktuální uživatel nemá oprávnění.");
    }

    private static DateTime ParseDate(string value, string field)
    {
        if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed))
            throw new BitcoinValidationException($"{field} není platné.");
        var date = parsed.UtcDateTime;
        if (date.Date > DateTime.UtcNow.Date) throw new BitcoinValidationException($"{field} nemůže být v budoucnosti.");
        return date;
    }

    private static string? ParseTxid(string? value)
    {
        var txid = NullIfWhiteSpace(value)?.ToLowerInvariant();
        if (txid is not null && !TxidPattern().IsMatch(txid))
            throw new BitcoinValidationException("TXID musí obsahovat 64 hexadecimálních znaků.");
        return txid;
    }

    private static string? ParseNote(string? value)
    {
        var note = NullIfWhiteSpace(value);
        if (note?.Length > 500) throw new BitcoinValidationException("Poznámka může mít nejvýše 500 znaků.");
        return note;
    }

    private static string RequestHash<T>(T request) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request))));

    private static ProofValues ValidateProof(SaveBitcoinProofRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Content))
            throw new BitcoinValidationException("Obsah dokladu je povinný.");
        var contentSizeBytes = Encoding.UTF8.GetByteCount(request.Content);
        if (contentSizeBytes > 1_000_000)
            throw new BitcoinValidationException("Doklad může mít nejvýše 1 MB.");
        var txid = ParseTxid(request.AnchorTxid);
        DateTime? anchoredAt = null;
        if (!string.IsNullOrWhiteSpace(request.AnchoredAt)) anchoredAt = ParseDate(request.AnchoredAt, "Datum ukotvení");
        if ((txid is null) != (anchoredAt is null))
            throw new BitcoinValidationException("TXID a datum ukotvení musí být vyplněny společně.");
        var sha256 = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(request.Content)));
        return new ProofValues(request.Content, contentSizeBytes, sha256, txid, anchoredAt, ParseNote(request.Note));
    }

    private static void AddProofParameters(
        NpgsqlCommand command,
        Guid householdId,
        Guid userId,
        Guid accountId,
        Guid proofId,
        DateTime createdAt,
        ProofValues proof)
    {
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("account_id", accountId);
        command.Parameters.AddWithValue("id", proofId);
        command.Parameters.AddWithValue("created_at", createdAt);
        AddProofValueParameters(command, proof);
    }

    private static void AddProofValueParameters(NpgsqlCommand command, ProofValues proof)
    {
        command.Parameters.AddWithValue("content", proof.Content);
        command.Parameters.AddWithValue("content_size_bytes", proof.ContentSizeBytes);
        command.Parameters.AddWithValue("sha256", proof.Sha256);
        command.Parameters.AddWithValue("anchor_txid", (object?)proof.AnchorTxid ?? DBNull.Value);
        command.Parameters.AddWithValue("anchored_at", NpgsqlDbType.TimestampTz, (object?)proof.AnchoredAt ?? DBNull.Value);
        command.Parameters.AddWithValue("note", (object?)proof.Note ?? DBNull.Value);
    }

    private static string? NullIfWhiteSpace(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex TxidPattern();

    private sealed record TransferChunk(Guid LotId, decimal? UnitPriceCzk, decimal QuantityBtc);
    private sealed record ProofValues(
        string Content,
        long ContentSizeBytes,
        string Sha256,
        string? AnchorTxid,
        DateTime? AnchoredAt,
        string? Note);
}

public sealed class BitcoinValidationException(string message) : Exception(message);
