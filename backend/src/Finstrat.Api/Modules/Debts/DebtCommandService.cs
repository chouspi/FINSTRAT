using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Finstrat.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Finstrat.Api.Modules.Debts;

public sealed class DebtCommandService(ApplicationDbContext dbContext)
{
    public async Task<DebtCommandResponse> CreateAsync(
        Guid householdId, Guid userId, CreateDebtRequest request, CancellationToken cancellationToken)
    {
        var name = ValidateName(request.Name);
        var amount = ParseAmount(request.OpeningBalanceCzk);
        var openedAt = ParseDate(request.OpenedAt, "Datum otevření", allowFuture: true);
        ValidatePriority(request.Priority);
        var note = ValidateNote(request.Note);
        var id = Guid.NewGuid();
        var entryId = Guid.NewGuid();
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        if (openedAt > await ReadLocalDateAsync(connection, householdId, cancellationToken))
            throw new DebtValidationException("Datum otevření nemůže být v budoucnosti.");
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand("""
                INSERT INTO debts (
                  id, household_id, owner_user_id, name, priority, is_mortgage, opened_at, note
                ) VALUES (
                  @id, @household_id, @user_id, @name, @priority, @is_mortgage, @opened_at, @note
                );
                INSERT INTO debt_entries (
                  id, household_id, debt_id, entry_type, amount_czk, effective_at, note, created_by
                ) VALUES (
                  @entry_id, @household_id, @id, 'opening_balance', @amount, @opened_at,
                  'Počáteční zůstatek', @user_id
                );
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description
                ) VALUES (
                  @household_id, @user_id, 'debt_created', 'debt', @id, 'Debt created'
                );
                """, connection, transaction);
            AddDebtParameters(command, householdId, userId, id, name, request.Priority, request.IsMortgage, openedAt, note);
            command.Parameters.AddWithValue("entry_id", entryId);
            command.Parameters.AddWithValue("amount", amount);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new DebtCommandResponse(id, amount, null);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task UpdateAsync(
        Guid householdId, Guid userId, Guid debtId, UpdateDebtRequest request,
        CancellationToken cancellationToken)
    {
        var name = ValidateName(request.Name);
        ValidatePriority(request.Priority);
        var note = ValidateNote(request.Note);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            WITH updated AS (
              UPDATE debts SET name = @name, priority = @priority,
                is_mortgage = @is_mortgage, note = @note
              WHERE household_id = @household_id AND owner_user_id = @user_id
                AND id = @debt_id AND archived_at IS NULL
              RETURNING id
            )
            INSERT INTO audit_events (
              household_id, actor_user_id, event_type, entity_type, entity_id, description
            )
            SELECT @household_id, @user_id, 'debt_updated', 'debt', id, 'Debt updated'
            FROM updated RETURNING entity_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("debt_id", debtId);
        command.Parameters.AddWithValue("name", name);
        command.Parameters.AddWithValue("priority", request.Priority);
        command.Parameters.AddWithValue("is_mortgage", request.IsMortgage);
        command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new DebtValidationException("Dluh nebyl nalezen.");
    }

    public async Task<DebtCommandResponse> PayAsync(
        Guid householdId, Guid userId, Guid debtId, Guid idempotencyKey,
        CreateDebtPaymentRequest request, CancellationToken cancellationToken)
    {
        var amount = ParseAmount(request.AmountCzk);
        var effectiveAt = ParseDate(request.EffectiveAt, "Datum splátky", allowFuture: true);
        var note = ValidateNote(request.Note);
        var requestHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request))));
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var replay = await RegisterIdempotencyAsync(connection, transaction, householdId, idempotencyKey, requestHash, cancellationToken);
            if (replay is not null) { await transaction.CommitAsync(cancellationToken); return replay; }
            await using var lockCommand = new NpgsqlCommand("""
                SELECT debt.opened_at, debt.closed_at,
                  (CURRENT_TIMESTAMP AT TIME ZONE household.time_zone)::date
                FROM debts debt
                JOIN households household ON household.id = debt.household_id
                WHERE debt.household_id = @household_id AND debt.owner_user_id = @user_id
                  AND debt.id = @debt_id AND debt.archived_at IS NULL
                FOR UPDATE OF debt
                """, connection, transaction);
            lockCommand.Parameters.AddWithValue("household_id", householdId);
            lockCommand.Parameters.AddWithValue("user_id", userId);
            lockCommand.Parameters.AddWithValue("debt_id", debtId);
            await using var reader = await lockCommand.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) throw new DebtValidationException("Dluh nebyl nalezen.");
            var openedAt = DateOnly.FromDateTime(reader.GetDateTime(0));
            var closed = !reader.IsDBNull(1);
            var localToday = DateOnly.FromDateTime(reader.GetDateTime(2));
            await reader.DisposeAsync();
            await using var balanceCommand = new NpgsqlCommand("""
                SELECT balance_czk FROM debt_balances
                WHERE household_id = @household_id AND debt_id = @debt_id
                """, connection, transaction);
            balanceCommand.Parameters.AddWithValue("household_id", householdId);
            balanceCommand.Parameters.AddWithValue("debt_id", debtId);
            var balance = (decimal)(await balanceCommand.ExecuteScalarAsync(cancellationToken)
                ?? throw new DebtValidationException("Zůstatek dluhu se nepodařilo načíst."));
            await using var scheduledCommand = new NpgsqlCommand("""
                SELECT COALESCE(sum(amount_czk), 0)
                FROM debt_entries
                WHERE household_id = @household_id AND debt_id = @debt_id
                  AND entry_type = 'scheduled_payment'
                """, connection, transaction);
            scheduledCommand.Parameters.AddWithValue("household_id", householdId);
            scheduledCommand.Parameters.AddWithValue("debt_id", debtId);
            var scheduled = (decimal)(await scheduledCommand.ExecuteScalarAsync(cancellationToken) ?? 0m);
            if (closed || balance <= 0) throw new DebtValidationException("Dluh je již splacený.");
            if (effectiveAt < openedAt) throw new DebtValidationException("Splátka nemůže předcházet otevření dluhu.");
            var availableBalance = balance - scheduled;
            if (amount > availableBalance) throw new DebtValidationException($"Splátka nesmí překročit nezarezervovaný zůstatek {availableBalance:0.00} Kč.");
            var isScheduled = effectiveAt > localToday;
            var remaining = isScheduled ? balance : balance - amount;
            var closedAt = !isScheduled && remaining == 0 ? effectiveAt : (DateOnly?)null;
            var paymentId = Guid.NewGuid();
            await using var command = new NpgsqlCommand("""
                INSERT INTO debt_entries (
                  id, household_id, debt_id, entry_type, amount_czk, effective_at, note, created_by
                ) VALUES (
                  @payment_id, @household_id, @debt_id, @entry_type, @amount, @effective_at, @note, @user_id
                );
                UPDATE debts SET closed_at = @closed_at
                WHERE household_id = @household_id AND id = @debt_id;
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description, metadata
                ) VALUES (
                  @household_id, @user_id, @event_type, 'debt_entry', @payment_id,
                  'Debt payment recorded', jsonb_build_object('debt_id', @debt_id, 'amount_czk', @amount)
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("payment_id", paymentId);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("debt_id", debtId);
            command.Parameters.AddWithValue("amount", amount);
            command.Parameters.AddWithValue("entry_type", isScheduled ? "scheduled_payment" : "payment");
            command.Parameters.AddWithValue("effective_at", effectiveAt);
            command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("closed_at", NpgsqlDbType.Date, (object?)closedAt ?? DBNull.Value);
            command.Parameters.AddWithValue("event_type", isScheduled ? "debt_payment_scheduled" : remaining == 0 ? "debt_paid_off" : "debt_payment_created");
            await command.ExecuteNonQueryAsync(cancellationToken);
            var response = new DebtCommandResponse(debtId, remaining, closedAt);
            await CompleteIdempotencyAsync(connection, transaction, householdId, idempotencyKey, response, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return response;
        }
        catch { await transaction.RollbackAsync(CancellationToken.None); throw; }
    }

    public async Task<DebtCommandResponse> DrawAsync(
        Guid householdId, Guid userId, Guid debtId, Guid idempotencyKey,
        CreateDebtDrawdownRequest request, CancellationToken cancellationToken)
    {
        var amount = ParseAmount(request.AmountCzk);
        var effectiveAt = ParseDate(request.EffectiveAt, "Datum navýšení", allowFuture: true);
        var note = ValidateNote(request.Note);
        var requestHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request))));
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var replay = await RegisterIdempotencyAsync(connection, transaction, householdId, idempotencyKey, requestHash, cancellationToken);
            if (replay is not null) { await transaction.CommitAsync(cancellationToken); return replay; }
            await using var lockCommand = new NpgsqlCommand("""
                SELECT debt.opened_at, debt.closed_at, balance.balance_czk,
                  (CURRENT_TIMESTAMP AT TIME ZONE household.time_zone)::date
                FROM debts debt
                JOIN debt_balances balance ON balance.household_id = debt.household_id AND balance.debt_id = debt.id
                JOIN households household ON household.id = debt.household_id
                WHERE debt.household_id = @household_id AND debt.owner_user_id = @user_id
                  AND debt.id = @debt_id AND debt.archived_at IS NULL
                FOR UPDATE OF debt
                """, connection, transaction);
            lockCommand.Parameters.AddWithValue("household_id", householdId);
            lockCommand.Parameters.AddWithValue("user_id", userId);
            lockCommand.Parameters.AddWithValue("debt_id", debtId);
            await using var reader = await lockCommand.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) throw new DebtValidationException("Dluh nebyl nalezen.");
            var openedAt = DateOnly.FromDateTime(reader.GetDateTime(0));
            var closed = !reader.IsDBNull(1);
            var balance = reader.GetDecimal(2);
            var localToday = DateOnly.FromDateTime(reader.GetDateTime(3));
            await reader.DisposeAsync();
            if (closed || balance <= 0) throw new DebtValidationException("Splacený dluh nelze navýšit.");
            if (effectiveAt < openedAt) throw new DebtValidationException("Navýšení nemůže předcházet otevření dluhu.");
            if (effectiveAt > localToday) throw new DebtValidationException("Datum navýšení nemůže být v budoucnosti.");
            var entryId = Guid.NewGuid();
            var newBalance = balance + amount;
            await using var command = new NpgsqlCommand("""
                INSERT INTO debt_entries (
                  id, household_id, debt_id, entry_type, amount_czk, effective_at, note, created_by
                ) VALUES (
                  @entry_id, @household_id, @debt_id, 'drawdown', @amount, @effective_at, @note, @user_id
                );
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id, description, metadata
                ) VALUES (
                  @household_id, @user_id, 'debt_drawdown_created', 'debt_entry', @entry_id,
                  'Debt drawdown recorded', jsonb_build_object('debt_id', @debt_id, 'amount_czk', @amount)
                );
                """, connection, transaction);
            command.Parameters.AddWithValue("entry_id", entryId);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("debt_id", debtId);
            command.Parameters.AddWithValue("amount", amount);
            command.Parameters.AddWithValue("effective_at", effectiveAt);
            command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
            command.Parameters.AddWithValue("user_id", userId);
            await command.ExecuteNonQueryAsync(cancellationToken);
            var response = new DebtCommandResponse(debtId, newBalance, null);
            await CompleteIdempotencyAsync(connection, transaction, householdId, idempotencyKey, response, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return response;
        }
        catch { await transaction.RollbackAsync(CancellationToken.None); throw; }
    }

    public async Task ArchiveAsync(Guid householdId, Guid userId, Guid debtId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            WITH archived AS (
              UPDATE debts debt SET archived_at = now()
              FROM debt_balances balance
               WHERE debt.household_id = @household_id AND debt.owner_user_id = @user_id
                 AND debt.id = @debt_id
                AND balance.household_id = debt.household_id AND balance.debt_id = debt.id
                AND balance.balance_czk = 0 AND debt.archived_at IS NULL
              RETURNING debt.id
            )
            INSERT INTO audit_events (
              household_id, actor_user_id, event_type, entity_type, entity_id, description
            ) SELECT @household_id, @user_id, 'debt_archived', 'debt', id, 'Debt archived'
              FROM archived RETURNING entity_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("debt_id", debtId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
            throw new DebtValidationException("Archivovat lze pouze splacený dluh.");
    }

    public async Task DeletePaymentAsync(
        Guid householdId, Guid userId, Guid debtId, Guid paymentId,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand("""
                WITH owned_payment AS (
                  SELECT entry.id, entry.amount_czk
                  FROM debt_entries entry
                  JOIN debts debt
                    ON debt.household_id = entry.household_id AND debt.id = entry.debt_id
                  WHERE entry.household_id = @household_id AND entry.debt_id = @debt_id
                    AND entry.id = @payment_id AND entry.entry_type IN ('payment', 'scheduled_payment')
                    AND debt.owner_user_id = @user_id AND debt.archived_at IS NULL
                  FOR UPDATE OF entry, debt
                ), deleted AS (
                  DELETE FROM debt_entries entry USING owned_payment payment
                  WHERE entry.id = payment.id
                  RETURNING entry.id, payment.amount_czk
                ), reopened AS (
                  UPDATE debts SET closed_at = NULL
                  WHERE household_id = @household_id AND id = @debt_id
                    AND EXISTS (SELECT 1 FROM deleted)
                )
                INSERT INTO audit_events (
                  household_id, actor_user_id, event_type, entity_type, entity_id,
                  description, metadata
                )
                SELECT @household_id, @user_id, 'debt_payment_deleted', 'debt_entry',
                  id, 'Debt payment deleted',
                  jsonb_build_object('debt_id', @debt_id, 'amount_czk', amount_czk)
                FROM deleted RETURNING entity_id
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("debt_id", debtId);
            command.Parameters.AddWithValue("payment_id", paymentId);
            if (await command.ExecuteScalarAsync(cancellationToken) is null)
                throw new DebtValidationException("Splátka nebyla nalezena.");
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<ConfirmScheduledPaymentsResponse> ConfirmDueScheduledPaymentsAsync(
        Guid householdId, Guid userId, CancellationToken cancellationToken) =>
        await ConfirmScheduledPaymentsAsync(householdId, userId, null, true, cancellationToken);

    public async Task<ConfirmScheduledPaymentsResponse> ConfirmScheduledPaymentAsync(
        Guid householdId, Guid userId, Guid paymentId, CancellationToken cancellationToken) =>
        await ConfirmScheduledPaymentsAsync(householdId, userId, paymentId, false, cancellationToken);

    private async Task<ConfirmScheduledPaymentsResponse> ConfirmScheduledPaymentsAsync(
        Guid householdId, Guid userId, Guid? paymentId, bool dueOnly,
        CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand("""
                WITH context AS (
                  SELECT (CURRENT_TIMESTAMP AT TIME ZONE time_zone)::date AS today
                  FROM households WHERE id = @household_id
                ), candidates AS (
                  SELECT entry.id, entry.debt_id, entry.amount_czk,
                    entry.effective_at, entry.note
                  FROM debt_entries entry
                  JOIN debts debt
                    ON debt.household_id = entry.household_id AND debt.id = entry.debt_id
                  CROSS JOIN context
                  WHERE entry.household_id = @household_id
                    AND debt.owner_user_id = @user_id AND debt.archived_at IS NULL
                    AND entry.entry_type = 'scheduled_payment'
                    AND (@payment_id IS NULL OR entry.id = @payment_id)
                    AND (NOT @due_only OR entry.effective_at <= context.today)
                  FOR UPDATE OF entry
                ), confirmed AS (
                  UPDATE debt_entries entry SET
                    entry_type = 'payment',
                    effective_at = LEAST(candidate.effective_at, context.today)
                  FROM candidates candidate, context
                  WHERE entry.id = candidate.id
                  RETURNING entry.id, entry.debt_id, entry.amount_czk,
                    candidate.effective_at, candidate.note
                ), audit AS (
                  INSERT INTO audit_events (
                    household_id, actor_user_id, event_type, entity_type, entity_id, description, metadata
                  )
                  SELECT @household_id, @user_id, 'debt_scheduled_payment_confirmed',
                    'debt_entry', id, 'Scheduled debt payment confirmed',
                    jsonb_build_object('debt_id', debt_id, 'amount_czk', amount_czk)
                  FROM confirmed
                )
                SELECT confirmed.debt_id, debt.name, confirmed.amount_czk,
                  confirmed.effective_at, context.today, confirmed.note
                FROM confirmed
                JOIN debts debt
                  ON debt.household_id = @household_id AND debt.id = confirmed.debt_id
                CROSS JOIN context
                ORDER BY confirmed.effective_at, confirmed.id
                """, connection, transaction);
            command.Parameters.AddWithValue("household_id", householdId);
            command.Parameters.AddWithValue("user_id", userId);
            command.Parameters.AddWithValue("payment_id", NpgsqlDbType.Uuid, (object?)paymentId ?? DBNull.Value);
            command.Parameters.AddWithValue("due_only", dueOnly);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            var payments = new List<ConfirmScheduledPaymentResponse>();
            while (await reader.ReadAsync(cancellationToken))
            {
                var effectiveAt = DateOnly.FromDateTime(reader.GetDateTime(3));
                var today = DateOnly.FromDateTime(reader.GetDateTime(4));
                var nextEffectiveAt = effectiveAt.AddMonths(1);
                while (nextEffectiveAt <= today) nextEffectiveAt = nextEffectiveAt.AddMonths(1);
                payments.Add(new ConfirmScheduledPaymentResponse(
                    reader.GetGuid(0), reader.GetString(1), reader.GetDecimal(2), effectiveAt,
                    nextEffectiveAt, reader.IsDBNull(5) ? null : reader.GetString(5)));
            }
            await reader.DisposeAsync();
            if (payments.Count == 0)
                throw new DebtValidationException(paymentId is null
                    ? "Není evidována žádná splatná plánovaná splátka."
                    : "Plánovaná splátka nebyla nalezena.");
            var result = new ConfirmScheduledPaymentsResponse(
                payments.Count, payments.Sum(payment => payment.AmountCzk), payments);
            await using var closeCommand = new NpgsqlCommand("""
                UPDATE debts debt SET closed_at = context.today
                FROM debt_balances balance, households household,
                  LATERAL (SELECT (CURRENT_TIMESTAMP AT TIME ZONE household.time_zone)::date AS today) context
                WHERE household.id = debt.household_id
                  AND debt.household_id = @household_id AND debt.owner_user_id = @user_id
                  AND balance.household_id = debt.household_id AND balance.debt_id = debt.id
                  AND balance.balance_czk = 0 AND debt.closed_at IS NULL
                """, connection, transaction);
            closeCommand.Parameters.AddWithValue("household_id", householdId);
            closeCommand.Parameters.AddWithValue("user_id", userId);
            await closeCommand.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return result;
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private static string ValidateName(string value) { var result = value.Trim(); if (result.Length is < 1 or > 100) throw new DebtValidationException("Název musí mít 1 až 100 znaků."); return result; }
    private static string? ValidateNote(string? value) { var result = string.IsNullOrWhiteSpace(value) ? null : value.Trim(); if (result?.Length > 500) throw new DebtValidationException("Poznámka může mít nejvýše 500 znaků."); return result; }
    private static void ValidatePriority(short value) { if (value is < 0 or > 5) throw new DebtValidationException("Priorita musí být 0 až 5."); }
    private static decimal ParseAmount(string value) { if (!decimal.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out var amount) || amount <= 0 || decimal.Round(amount, 2) != amount) throw new DebtValidationException("Částka musí být kladné číslo s nejvýše dvěma desetinnými místy."); return amount; }
    private static DateOnly ParseDate(string value, string field, bool allowFuture = false) { if (!DateOnly.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) throw new DebtValidationException($"{field} není platné."); if (!allowFuture && date > DateOnly.FromDateTime(DateTime.UtcNow)) throw new DebtValidationException($"{field} nemůže být v budoucnosti."); return date; }
    private static async Task<DateOnly> ReadLocalDateAsync(NpgsqlConnection connection, Guid householdId, CancellationToken cancellationToken) { await using var command = new NpgsqlCommand("SELECT (CURRENT_TIMESTAMP AT TIME ZONE time_zone)::date FROM households WHERE id = @household_id", connection); command.Parameters.AddWithValue("household_id", householdId); return await command.ExecuteScalarAsync(cancellationToken) is DateOnly date ? date : throw new DebtValidationException("Časové pásmo domácnosti nebylo nalezeno."); }
    private static void AddDebtParameters(NpgsqlCommand command, Guid householdId, Guid userId, Guid id, string name, short priority, bool mortgage, DateOnly openedAt, string? note) { command.Parameters.AddWithValue("id", id); command.Parameters.AddWithValue("household_id", householdId); command.Parameters.AddWithValue("user_id", userId); command.Parameters.AddWithValue("name", name); command.Parameters.AddWithValue("priority", priority); command.Parameters.AddWithValue("is_mortgage", mortgage); command.Parameters.AddWithValue("opened_at", openedAt); command.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value); }

    private static async Task<DebtCommandResponse?> RegisterIdempotencyAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId, Guid key, string hash, CancellationToken cancellationToken) { await using var insert = new NpgsqlCommand("INSERT INTO idempotency_keys (household_id,key,request_hash,expires_at) VALUES (@h,@k,@r,now()+interval '24 hours') ON CONFLICT DO NOTHING", connection, transaction); insert.Parameters.AddWithValue("h", householdId); insert.Parameters.AddWithValue("k", key); insert.Parameters.AddWithValue("r", hash); if (await insert.ExecuteNonQueryAsync(cancellationToken) == 1) return null; await using var select = new NpgsqlCommand("SELECT request_hash,response_body FROM idempotency_keys WHERE household_id=@h AND key=@k", connection, transaction); select.Parameters.AddWithValue("h", householdId); select.Parameters.AddWithValue("k", key); await using var reader = await select.ExecuteReaderAsync(cancellationToken); await reader.ReadAsync(cancellationToken); if (reader.GetString(0) != hash) throw new DebtValidationException("Idempotency key už byl použit."); if (reader.IsDBNull(1)) throw new DebtValidationException("Stejná splátka se zpracovává."); return JsonSerializer.Deserialize<DebtCommandResponse>(reader.GetString(1)); }
    private static async Task CompleteIdempotencyAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid householdId, Guid key, DebtCommandResponse response, CancellationToken cancellationToken) { await using var command = new NpgsqlCommand("UPDATE idempotency_keys SET response_status=201,response_body=@body WHERE household_id=@h AND key=@k", connection, transaction); command.Parameters.AddWithValue("h", householdId); command.Parameters.AddWithValue("k", key); command.Parameters.AddWithValue("body", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(response)); await command.ExecuteNonQueryAsync(cancellationToken); }
}

public sealed class DebtValidationException(string message) : Exception(message);
