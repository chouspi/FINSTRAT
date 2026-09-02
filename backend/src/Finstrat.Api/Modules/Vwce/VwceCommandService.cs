using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.MarketData;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Finstrat.Api.Modules.Vwce;

public sealed class VwceCommandService(ApplicationDbContext dbContext, VwcePriceService priceService)
{
    public async Task<CreateVwceAccountResponse> CreateAccountAsync(
        Guid householdId,
        Guid userId,
        CreateVwceAccountRequest request,
        CancellationToken cancellationToken)
    {
        var name = request.Name.Trim();
        var description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim();
        if (name.Length is < 1 or > 100) throw new VwceValidationException("Název účtu musí mít 1 až 100 znaků.");
        if (description?.Length > 500) throw new VwceValidationException("Popis účtu může mít nejvýše 500 znaků.");

        var id = Guid.NewGuid();
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand("""
                INSERT INTO vwce_accounts (id, household_id, owner_user_id, name, description)
                VALUES (@id, @household_id, @user_id, @name, @description);
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'vwce_account_created', 'vwce_account', @id,
                  'VWCE account created'
                );
                """, connection);
            command.Parameters.AddWithValue("id", id);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("name", name);
            command.Parameters.AddWithValue("description", (object?)description ?? DBNull.Value);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return new CreateVwceAccountResponse(id, name, description);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new VwceValidationException("Aktivní broker s tímto názvem už existuje.");
        }
    }

    public async Task<CreateVwcePayoutResponse> CreatePayoutAsync(
        Guid householdId,
        Guid userId,
        Guid idempotencyKey,
        CreateVwcePayoutRequest request,
        CancellationToken cancellationToken)
    {
        if (!decimal.TryParse(request.AmountCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out var requestedAmount)
            || requestedAmount <= 0)
            throw new VwceValidationException("Částka k výplatě musí být kladné číslo.");
        if (!DateTimeOffset.TryParse(request.PaidAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsedAt))
            throw new VwceValidationException("Datum výplaty není platné.");
        var paidAt = parsedAt.UtcDateTime;
        if (paidAt.Date > DateTime.UtcNow.Date) throw new VwceValidationException("Datum výplaty nemůže být v budoucnosti.");

        var marketPrice = await priceService.GetAsync(cancellationToken);
        var unitPriceCzk = decimal.Round(marketPrice.PriceCzk, 2, MidpointRounding.ToEven);
        var shares = decimal.Round(requestedAmount / unitPriceCzk, 8, MidpointRounding.ToEven);
        if (shares <= 0) throw new VwceValidationException("Částka je příliš nízká pro výpočet prodávaných podílů.");
        var proceedsCzk = decimal.Round(shares * unitPriceCzk, 2, MidpointRounding.ToEven);
        var note = string.IsNullOrWhiteSpace(request.Note)
            ? $"Výplata renty – prodej {shares:0.########} ks"
            : request.Note.Trim();
        if (note.Length > 500) throw new VwceValidationException("Poznámka může mít nejvýše 500 znaků.");

        var requestHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request))));
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var replay = await RegisterIdempotencyAsync<CreateVwcePayoutResponse>(
                connection, transaction, householdId, idempotencyKey, requestHash, cancellationToken);
            if (replay is not null)
            {
                await transaction.CommitAsync(cancellationToken);
                return replay;
            }

            await EnsureOwnedAccountAsync(
                connection, transaction, householdId, userId, request.AccountId, cancellationToken);
            var latestActivity = await LatestActivityAsync(
                connection, transaction, householdId, request.AccountId, cancellationToken);
            if (latestActivity is not null && paidAt < latestActivity)
                throw new VwceValidationException("Výplatu nelze vložit před novější pohyb na účtu.");
            var chunks = await AllocateLotsAsync(
                connection, transaction, householdId, request.AccountId, shares, paidAt, cancellationToken);

            var id = Guid.NewGuid();
            await using (var command = new NpgsqlCommand("""
                INSERT INTO vwce_disposals (
                  id, household_id, account_id, kind, shares, unit_price_czk,
                  proceeds_czk, disposed_at, note, created_by
                ) VALUES (
                  @id, @household_id, @account_id, 'rent_payout', @shares, @unit_price_czk,
                  @proceeds_czk, @paid_at, @note, @user_id
                );
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id,
                  description, metadata
                ) VALUES (
                  @household_id, @user_id, 'vwce_rent_payout_created', 'vwce_disposal', @id,
                  'VWCE rent payout created', jsonb_build_object('amount_czk', @proceeds_czk, 'shares', @shares)
                );
                """, connection, transaction))
            {
                command.Parameters.AddWithValue("id", id);
                command.Parameters.AddWithValue("household_id", householdId);
                command.Parameters.AddWithValue("account_id", request.AccountId);
                command.Parameters.AddWithValue("shares", shares);
                command.Parameters.AddWithValue("unit_price_czk", unitPriceCzk);
                command.Parameters.AddWithValue("proceeds_czk", proceedsCzk);
                command.Parameters.AddWithValue("paid_at", paidAt);
                command.Parameters.AddWithValue("note", note);
                command.Parameters.AddWithValue("user_id", userId);
                await command.ExecuteNonQueryAsync(cancellationToken);
            }

            foreach (var chunk in chunks)
            {
                await using var allocation = new NpgsqlCommand("""
                    INSERT INTO vwce_lot_allocations (
                      household_id, disposal_id, lot_id, shares, cost_basis_czk
                    ) VALUES (
                      @household_id, @disposal_id, @lot_id, @shares,
                      CASE WHEN @lot_price IS NULL THEN NULL ELSE round(@shares * @lot_price, 2) END
                    )
                    """, connection, transaction);
                allocation.Parameters.AddWithValue("household_id", householdId);
                allocation.Parameters.AddWithValue("disposal_id", id);
                allocation.Parameters.AddWithValue("lot_id", chunk.LotId);
                allocation.Parameters.AddWithValue("shares", chunk.Shares);
                allocation.Parameters.AddWithValue("lot_price", NpgsqlDbType.Numeric, (object?)chunk.UnitPriceCzk ?? DBNull.Value);
                await allocation.ExecuteNonQueryAsync(cancellationToken);
            }

            var response = new CreateVwcePayoutResponse(
                id, request.AccountId, proceedsCzk, shares, unitPriceCzk, paidAt, note);
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

    public async Task<UpdateVwceAccountResponse> UpdateAccountAsync(
        Guid householdId, Guid userId, Guid accountId, UpdateVwceAccountRequest request,
        CancellationToken cancellationToken)
    {
        var name = request.Name.Trim();
        var description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim();
        if (name.Length is < 1 or > 100) throw new VwceValidationException("Název účtu musí mít 1 až 100 znaků.");
        if (description?.Length > 500) throw new VwceValidationException("Popis účtu může mít nejvýše 500 znaků.");

        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand("""
                WITH updated AS (
                  UPDATE vwce_accounts SET name = @name, description = @description
                  WHERE household_id = @household_id AND id = @account_id
                    AND owner_user_id = @user_id AND archived_at IS NULL
                  RETURNING id
                ), audit AS (
                  INSERT INTO audit_events (
                    household_id, actor_user_id, event_type, entity_type, entity_id, description
                  )
                  SELECT @household_id, @user_id, 'vwce_account_updated', 'vwce_account', id,
                    'VWCE account updated' FROM updated
                )
                SELECT id FROM updated
                """, connection);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("account_id", accountId);
            command.Parameters.AddWithValue("name", name);
            command.Parameters.AddWithValue("description", (object?)description ?? DBNull.Value);
            if (await command.ExecuteScalarAsync(cancellationToken) is null)
                throw new VwceValidationException("Broker účet nebyl nalezen nebo jej může upravit pouze vlastník.");
            return new UpdateVwceAccountResponse(accountId, name, description);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new VwceValidationException("Aktivní broker s tímto názvem už existuje.");
        }
    }

    public async Task ArchiveAccountAsync(
        Guid householdId, Guid userId, Guid accountId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            WITH archived AS (
              UPDATE vwce_accounts SET archived_at = now()
              WHERE household_id = @household_id AND id = @account_id
                AND owner_user_id = @user_id AND archived_at IS NULL
              RETURNING id
            )
            INSERT INTO audit_events (
              household_id, actor_user_id, event_type, entity_type, entity_id, description
            )
            SELECT @household_id, @user_id, 'vwce_account_archived', 'vwce_account', id,
              'VWCE account archived' FROM archived
            RETURNING entity_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("account_id", accountId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new VwceValidationException("Broker účet nebyl nalezen nebo jej může odstranit pouze vlastník.");
    }

    public async Task UpdatePurchaseMovementAsync(
        Guid householdId, Guid userId, Guid movementId,
        UpdateVwcePurchaseMovementRequest request, CancellationToken cancellationToken)
    {
        if (!decimal.TryParse(request.Shares, NumberStyles.Number, CultureInfo.InvariantCulture, out var shares)
            || shares <= 0 || ((decimal.GetBits(shares)[3] >> 16) & 0x7F) > 8)
            throw new VwceValidationException("Počet podílů musí být kladné číslo s nejvýše 8 desetinnými místy.");
        if (!decimal.TryParse(request.UnitPriceCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out var unitPriceCzk)
            || unitPriceCzk <= 0) throw new VwceValidationException("Cena za podíl musí být kladné číslo.");
        if (!DateTimeOffset.TryParse(request.AcquiredAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsedAt))
            throw new VwceValidationException("Datum nákupu není platné.");
        var acquiredAt = parsedAt.UtcDateTime;
        if (acquiredAt.Date > DateTime.UtcNow.Date) throw new VwceValidationException("Datum nákupu nemůže být v budoucnosti.");
        var note = string.IsNullOrWhiteSpace(request.Note) ? null : request.Note.Trim();
        if (note?.Length > 500) throw new VwceValidationException("Poznámka může mít nejvýše 500 znaků.");

        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await EnsureEditablePurchaseAsync(connection, transaction, householdId, userId, movementId, cancellationToken);
            await using var command = new NpgsqlCommand("""
                UPDATE vwce_lots SET shares = @shares, unit_price_czk = @unit_price_czk,
                  acquired_at = @acquired_at, note = @note
                WHERE household_id = @household_id AND id = @movement_id;
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'vwce_purchase_updated', 'vwce_lot', @movement_id,
                  'VWCE purchase updated'
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("movement_id", movementId);
            command.Parameters.AddWithValue("shares", shares);
            command.Parameters.AddWithValue("unit_price_czk", unitPriceCzk);
            command.Parameters.AddWithValue("acquired_at", acquiredAt);
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

    public async Task<CreateVwcePurchaseResponse> CreatePurchaseAsync(
        Guid householdId, Guid userId, Guid accountId, Guid idempotencyKey,
        CreateVwcePurchaseRequest request, CancellationToken cancellationToken)
    {
        if (!decimal.TryParse(request.Shares, NumberStyles.Number, CultureInfo.InvariantCulture, out var shares)
            || shares <= 0 || ((decimal.GetBits(shares)[3] >> 16) & 0x7F) > 8)
            throw new VwceValidationException("Počet podílů musí být kladné číslo s nejvýše 8 desetinnými místy.");
        if (!decimal.TryParse(request.UnitPriceCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out var unitPriceCzk)
            || unitPriceCzk <= 0 || decimal.Round(unitPriceCzk, 2) != unitPriceCzk)
            throw new VwceValidationException("Cena za podíl musí být kladné číslo s nejvýše 2 desetinnými místy.");
        if (!DateTimeOffset.TryParse(request.AcquiredAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsedAt))
            throw new VwceValidationException("Datum nákupu není platné.");
        var acquiredAt = parsedAt.UtcDateTime;
        if (acquiredAt.Date > DateTime.UtcNow.Date) throw new VwceValidationException("Datum nákupu nemůže být v budoucnosti.");
        var note = string.IsNullOrWhiteSpace(request.Note) ? null : request.Note.Trim();
        if (note?.Length > 500) throw new VwceValidationException("Poznámka může mít nejvýše 500 znaků.");
        var deferredVwceAmountCzk = 0m;
        if (request.ConsumeDeferredVwce
            && (!decimal.TryParse(request.DeferredVwceAmountCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out deferredVwceAmountCzk)
                || deferredVwceAmountCzk <= 0 || decimal.Round(deferredVwceAmountCzk, 2) != deferredVwceAmountCzk))
            throw new VwceValidationException("Částka z Income poolu musí být kladné číslo s nejvýše 2 desetinnými místy.");
        var requestHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request))));
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var replay = await RegisterIdempotencyAsync<CreateVwcePurchaseResponse>(
                connection, transaction, householdId, idempotencyKey, requestHash, cancellationToken);
            if (replay is not null) { await transaction.CommitAsync(cancellationToken); return replay; }
            var accountOwnerId = await EnsureOwnedAccountAsync(connection, transaction, householdId, userId, accountId, cancellationToken);
            if (request.ConsumeDeferredVwce && accountOwnerId != userId)
                throw new VwceValidationException("Income pool lze použít pouze na vlastním VWCE účtu.");
            var latestActivity = await LatestActivityAsync(connection, transaction, householdId, accountId, cancellationToken);
            if (latestActivity is not null && acquiredAt < latestActivity)
                throw new VwceValidationException("Nákup nelze vložit před novější pohyb na účtu.");
            var id = Guid.NewGuid();
            await using var command = new NpgsqlCommand("""
                INSERT INTO vwce_lots (
                  id, household_id, account_id, shares, unit_price_czk, acquired_at, note, created_by
                ) VALUES (
                  @id, @household_id, @account_id, @shares, @unit_price_czk, @acquired_at, @note, @user_id
                );
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description, metadata
                ) VALUES (
                  @household_id, @user_id, 'vwce_purchase_created', 'vwce_lot', @id,
                  'VWCE purchase created', jsonb_build_object('shares', @shares, 'unit_price_czk', @unit_price_czk)
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("id", id);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("account_id", accountId);
            command.Parameters.AddWithValue("shares", shares);
            command.Parameters.AddWithValue("unit_price_czk", unitPriceCzk);
            command.Parameters.AddWithValue("acquired_at", acquiredAt);
            command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
            command.Parameters.AddWithValue("user_id", userId);
            await command.ExecuteNonQueryAsync(cancellationToken);
            var deferred = request.ConsumeDeferredVwce
                ? await AllocateDeferredVwceAsync(connection, transaction, householdId, accountOwnerId, id,
                    deferredVwceAmountCzk, DateOnly.FromDateTime(acquiredAt), cancellationToken)
                : (0m, await ReadDeferredVwceRemainingAsync(connection, transaction, householdId, accountOwnerId, cancellationToken));
            var response = new CreateVwcePurchaseResponse(id, accountId, shares, unitPriceCzk, acquiredAt, note, deferred.Item1, deferred.Item2);
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
                DELETE FROM vwce_lots WHERE household_id = @household_id AND id = @movement_id;
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'vwce_purchase_deleted', 'vwce_lot', @movement_id,
                  'VWCE purchase deleted'
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
            SELECT 1 FROM vwce_lots lot
            JOIN vwce_accounts account ON account.household_id = lot.household_id AND account.id = lot.account_id
            WHERE lot.household_id = @household_id AND lot.id = @movement_id
              AND account.archived_at IS NULL AND NOT lot.provisional
              AND lot.unit_price_czk IS NOT NULL AND lot.source_reallocation_id IS NULL
              AND lot.replaces_lot_id IS NULL
              AND (
                account.owner_user_id = @user_id
                OR EXISTS (
                  SELECT 1 FROM vwce_account_shares share
                  JOIN users acting_user ON acting_user.id = share.user_id
                  WHERE share.household_id = account.household_id AND share.account_id = account.id
                    AND share.user_id = @user_id AND acting_user.is_default
                )
              )
              AND NOT EXISTS (SELECT 1 FROM vwce_lot_allocations allocation WHERE allocation.lot_id = lot.id)
              AND NOT EXISTS (SELECT 1 FROM deferred_vwce_allocations allocation WHERE allocation.vwce_lot_id = lot.id)
              AND NOT EXISTS (SELECT 1 FROM vwce_lots replacement WHERE replacement.replaces_lot_id = lot.id)
              AND NOT EXISTS (SELECT 1 FROM vwce_lots later WHERE later.account_id = lot.account_id AND (later.acquired_at, later.id) > (lot.acquired_at, lot.id))
              AND NOT EXISTS (SELECT 1 FROM vwce_disposals later WHERE later.account_id = lot.account_id AND later.disposed_at >= lot.acquired_at)
            FOR UPDATE OF lot
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("movement_id", movementId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new VwceValidationException("Pohyb nelze upravit ani odstranit, protože na něj navazuje další účetní pohyb.");
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
                FROM vwce_accounts account
                JOIN household_members default_member ON default_member.household_id = account.household_id
                JOIN users default_user ON default_user.id = default_member.user_id AND default_user.is_default
                WHERE account.household_id = @household_id AND account.id = @account_id
                  AND account.owner_user_id = @user_id AND account.archived_at IS NULL
                  AND default_user.id <> @user_id
                FOR UPDATE OF account
                """, connection, transaction);
            targetCommand.Parameters.AddWithValue("household_id", householdId);
            targetCommand.Parameters.AddWithValue("account_id", accountId);
            targetCommand.Parameters.AddWithValue("user_id", userId);
            var defaultUserId = await targetCommand.ExecuteScalarAsync(cancellationToken) as Guid?;
            if (defaultUserId is null)
                throw new VwceValidationException("Sdílení může změnit pouze vlastník účtu, který není defaultním uživatelem.");

            var sql = shared
                ? """
                  INSERT INTO vwce_account_shares (household_id, account_id, user_id, created_by)
                  VALUES (@household_id, @account_id, @default_user_id, @user_id)
                  ON CONFLICT (account_id, user_id) DO NOTHING;
                  """
                : """
                  DELETE FROM vwce_account_shares
                  WHERE household_id = @household_id AND account_id = @account_id
                    AND user_id = @default_user_id;
                  """;
            await using var command = new NpgsqlCommand(sql + """
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id,
                  description, metadata
                ) VALUES (
                  @household_id, @user_id, 'vwce_account_default_sharing_changed',
                  'vwce_account', @account_id, 'VWCE account default sharing changed',
                  jsonb_build_object('shared', @shared)
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("account_id", accountId);
            command.Parameters.AddWithValue("default_user_id", defaultUserId.Value);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("shared", shared);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private static async Task<Guid> EnsureOwnedAccountAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId,
        Guid userId, Guid accountId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT account.owner_user_id FROM vwce_accounts account
            WHERE account.household_id = @household_id AND account.id = @account_id
              AND account.archived_at IS NULL
              AND (
                account.owner_user_id = @user_id
                OR EXISTS (
                  SELECT 1 FROM vwce_account_shares share
                  JOIN users acting_user ON acting_user.id = share.user_id
                  WHERE share.household_id = account.household_id AND share.account_id = account.id
                    AND share.user_id = @user_id AND acting_user.is_default
                )
              )
            FOR UPDATE OF account
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("account_id", accountId);
        var owner = await command.ExecuteScalarAsync(cancellationToken);
        if (owner is null)
            throw new VwceValidationException("Broker účet nebyl nalezen nebo jej aktuální uživatel nevlastní.");
        return (Guid)owner;
    }

    private static async Task<(decimal Consumed, decimal Remaining)> AllocateDeferredVwceAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId, Guid ownerUserId,
        Guid lotId, decimal requestedCzk, DateOnly allocatedAt, CancellationToken cancellationToken)
    {
        await using var select = new NpgsqlCommand("""
            WITH locked_obligations AS (
              SELECT * FROM deferred_vwce_obligations
              WHERE household_id=@household_id AND owner_user_id=@owner_user_id
              FOR UPDATE
            )
            SELECT obligation.id, GREATEST(obligation.original_amount_czk-obligation.cancelled_amount_czk-COALESCE(SUM(allocation.amount_czk),0),0) remaining
            FROM locked_obligations obligation LEFT JOIN deferred_vwce_allocations allocation
              ON allocation.household_id=obligation.household_id AND allocation.obligation_id=obligation.id
            GROUP BY obligation.id,obligation.original_amount_czk,obligation.cancelled_amount_czk,obligation.deferred_at
            HAVING GREATEST(obligation.original_amount_czk-obligation.cancelled_amount_czk-COALESCE(SUM(allocation.amount_czk),0),0)>0
            ORDER BY obligation.deferred_at,obligation.id
            """, connection, transaction);
        select.Parameters.AddWithValue("household_id", householdId); select.Parameters.AddWithValue("owner_user_id", ownerUserId);
        var open = new List<(Guid Id, decimal Remaining)>();
        await using (var reader = await select.ExecuteReaderAsync(cancellationToken))
            while (await reader.ReadAsync(cancellationToken)) open.Add((reader.GetGuid(0), reader.GetDecimal(1)));
        var left = requestedCzk;
        var consumed = 0m;
        foreach (var obligation in open)
        {
            var amount = Math.Min(obligation.Remaining, left);
            if (amount <= 0) break;
            await using var insert = new NpgsqlCommand("""
                INSERT INTO deferred_vwce_allocations (household_id,obligation_id,vwce_lot_id,amount_czk,allocated_at)
                VALUES (@household_id,@obligation_id,@lot_id,@amount,@allocated_at);
                UPDATE deferred_vwce_obligations SET completed_at=@allocated_at
                WHERE id=@obligation_id AND @amount=@remaining;
                """, connection, transaction);
            insert.Parameters.AddWithValue("household_id", householdId); insert.Parameters.AddWithValue("obligation_id", obligation.Id);
            insert.Parameters.AddWithValue("lot_id", lotId); insert.Parameters.AddWithValue("amount", amount);
            insert.Parameters.AddWithValue("remaining", obligation.Remaining); insert.Parameters.AddWithValue("allocated_at", allocatedAt);
            await insert.ExecuteNonQueryAsync(cancellationToken);
            consumed += amount; left -= amount;
        }
        return (consumed, await ReadDeferredVwceRemainingAsync(connection, transaction, householdId, ownerUserId, cancellationToken));
    }

    private static async Task<decimal> ReadDeferredVwceRemainingAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId, Guid ownerUserId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT COALESCE(SUM(GREATEST(obligation.original_amount_czk-obligation.cancelled_amount_czk-COALESCE(allocated.amount_czk,0),0)),0)
            FROM deferred_vwce_obligations obligation LEFT JOIN LATERAL
              (SELECT SUM(amount_czk) amount_czk FROM deferred_vwce_allocations allocation WHERE allocation.obligation_id=obligation.id) allocated ON true
            WHERE obligation.household_id=@household_id AND obligation.owner_user_id=@owner_user_id
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId); command.Parameters.AddWithValue("owner_user_id", ownerUserId);
        return (decimal)(await command.ExecuteScalarAsync(cancellationToken) ?? 0m);
    }

    private static async Task<DateTime?> LatestActivityAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId,
        Guid accountId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT MAX(occurred_at) FROM (
              SELECT acquired_at AS occurred_at FROM vwce_lots
              WHERE household_id = @household_id AND account_id = @account_id
              UNION ALL
              SELECT disposed_at FROM vwce_disposals
              WHERE household_id = @household_id AND account_id = @account_id
            ) activity
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("account_id", accountId);
        return await command.ExecuteScalarAsync(cancellationToken) as DateTime?;
    }

    private static async Task<List<PayoutChunk>> AllocateLotsAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId,
        Guid accountId, decimal shares, DateTime paidAt, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT lot.id, lot.unit_price_czk,
              lot.shares - COALESCE(allocated.shares, 0) AS remaining_shares
            FROM vwce_lots lot
            LEFT JOIN LATERAL (
              SELECT SUM(allocation.shares) AS shares FROM vwce_lot_allocations allocation
              WHERE allocation.household_id = lot.household_id AND allocation.lot_id = lot.id
            ) allocated ON true
            WHERE lot.household_id = @household_id AND lot.account_id = @account_id
              AND lot.acquired_at <= @paid_at
              AND lot.shares - COALESCE(allocated.shares, 0) > 0
              AND NOT EXISTS (
                SELECT 1 FROM vwce_lots replacement
                WHERE replacement.household_id = lot.household_id AND replacement.replaces_lot_id = lot.id
              )
            ORDER BY lot.acquired_at, lot.id
            FOR UPDATE OF lot
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("account_id", accountId);
        command.Parameters.AddWithValue("paid_at", paidAt);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var remaining = shares;
        var chunks = new List<PayoutChunk>();
        while (remaining > 0 && await reader.ReadAsync(cancellationToken))
        {
            var available = reader.GetDecimal(2);
            var allocated = decimal.Min(available, remaining);
            chunks.Add(new PayoutChunk(reader.GetGuid(0), reader.IsDBNull(1) ? null : reader.GetDecimal(1), allocated));
            remaining -= allocated;
        }
        if (remaining > 0) throw new VwceValidationException($"Na broker účtu chybí {remaining:0.########} ks VWCE.");
        return chunks;
    }

    private static async Task<T?> RegisterIdempotencyAsync<T>(
        NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId,
        Guid key, string requestHash, CancellationToken cancellationToken) where T : class
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
        if (reader.GetString(0) != requestHash) throw new VwceValidationException("Idempotency key už byl použit pro jiný požadavek.");
        if (reader.IsDBNull(1)) throw new VwceValidationException("Stejná výplata se právě zpracovává.");
        return JsonSerializer.Deserialize<T>(reader.GetString(1))
            ?? throw new InvalidOperationException("Stored idempotency response is invalid.");
    }

    private static async Task CompleteIdempotencyAsync<T>(
        NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId,
        Guid key, T response, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            UPDATE idempotency_keys SET response_status = 201, response_body = @response_body
            WHERE household_id = @household_id AND key = @key
            """, connection, transaction);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("key", key);
        command.Parameters.AddWithValue("response_body", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(response));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private sealed record PayoutChunk(Guid LotId, decimal? UnitPriceCzk, decimal Shares);
}

public sealed class VwceValidationException(string message) : Exception(message);
