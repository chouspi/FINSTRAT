using System.Data;
using Finstrat.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Finstrat.Api.Modules.Debts;

public sealed class DebtQueryService(ApplicationDbContext dbContext)
{
    public async Task<DebtOverviewResponse> GetOverviewAsync(
        Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        var shouldClose = connection.State != ConnectionState.Open;
        if (shouldClose) await connection.OpenAsync(cancellationToken);
        try
        {
            var debts = await ReadDebtsAsync(connection, householdId, userId, cancellationToken);
            var entries = await ReadEntriesAsync(connection, householdId, userId, null, 12, cancellationToken);
            var scheduledPayments = await ReadScheduledPaymentsAsync(connection, householdId, userId, cancellationToken);
            var active = debts.Where(debt => debt.ClosedAt is null && debt.BalanceCzk > 0).ToList();
            return new DebtOverviewResponse(
                new DebtTotalsResponse(
                    active.Sum(debt => debt.BalanceCzk),
                    active.Where(debt => !debt.IsMortgage).Sum(debt => debt.BalanceCzk),
                    active.Where(debt => debt.IsMortgage).Sum(debt => debt.BalanceCzk),
                    active.Count,
                    debts.Count(debt => debt.ClosedAt is not null || debt.BalanceCzk == 0)),
                debts,
                entries,
                scheduledPayments);
        }
        finally
        {
            if (shouldClose) await connection.CloseAsync();
        }
    }

    public async Task<IReadOnlyList<DebtEntryResponse>> GetEntriesAsync(
        Guid householdId, Guid userId, Guid debtId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        return await ReadEntriesAsync(connection, householdId, userId, debtId, null, cancellationToken);
    }

    private static async Task<List<DebtResponse>> ReadDebtsAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT debt.id, debt.name, debt.priority, debt.is_mortgage, debt.opened_at,
              debt.closed_at, debt.note, balance.balance_czk,
              COALESCE(sum(entry.amount_czk) FILTER (
                WHERE entry.entry_type = 'scheduled_payment'
              ), 0)::numeric(20,2),
              COUNT(entry.id)::int, MAX(entry.effective_at)
            FROM debts debt
            JOIN households household ON household.id = debt.household_id
            JOIN debt_balances balance ON balance.household_id = debt.household_id AND balance.debt_id = debt.id
            LEFT JOIN debt_entries entry ON entry.household_id = debt.household_id AND entry.debt_id = debt.id
            WHERE debt.household_id = @household_id AND debt.owner_user_id = @user_id
              AND debt.archived_at IS NULL
            GROUP BY debt.id, balance.balance_czk
            ORDER BY debt.closed_at NULLS FIRST, debt.is_mortgage, debt.priority DESC, debt.created_at
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var debts = new List<DebtResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            debts.Add(new DebtResponse(
                reader.GetGuid(0), reader.GetString(1), reader.GetInt16(2), reader.GetBoolean(3),
                DateOnly.FromDateTime(reader.GetDateTime(4)), reader.IsDBNull(5) ? null : DateOnly.FromDateTime(reader.GetDateTime(5)),
                reader.IsDBNull(6) ? null : reader.GetString(6), reader.GetDecimal(7), reader.GetDecimal(8),
                reader.GetInt32(9), reader.IsDBNull(10) ? null : DateOnly.FromDateTime(reader.GetDateTime(10))));
        }
        return debts;
    }

    private static async Task<List<DebtEntryResponse>> ReadEntriesAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, Guid? debtId, int? limit,
        CancellationToken cancellationToken)
    {
        var sql = """
            SELECT entry.id, debt.id, debt.name, entry.entry_type, entry.amount_czk,
              entry.effective_at,
              entry.entry_type = 'scheduled_payment',
              entry.entry_type = 'scheduled_payment'
                AND entry.effective_at <= (CURRENT_TIMESTAMP AT TIME ZONE household.time_zone)::date,
              entry.note
            FROM debt_entries entry
            JOIN debts debt ON debt.household_id = entry.household_id AND debt.id = entry.debt_id
            JOIN households household ON household.id = entry.household_id
            WHERE entry.household_id = @household_id
              AND debt.owner_user_id = @user_id
              AND (@debt_id IS NULL OR entry.debt_id = @debt_id)
            ORDER BY entry.effective_at DESC, entry.id DESC
            """ + (limit is null ? "" : " LIMIT @limit");
        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("debt_id", NpgsqlTypes.NpgsqlDbType.Uuid, (object?)debtId ?? DBNull.Value);
        if (limit is not null) command.Parameters.AddWithValue("limit", limit.Value);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var entries = new List<DebtEntryResponse>();
        while (await reader.ReadAsync(cancellationToken))
        {
            entries.Add(new DebtEntryResponse(
                reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
                reader.GetDecimal(4), DateOnly.FromDateTime(reader.GetDateTime(5)), reader.GetBoolean(6),
                reader.GetBoolean(7), reader.IsDBNull(8) ? null : reader.GetString(8)));
        }
        return entries;
    }

    private static async Task<List<DebtEntryResponse>> ReadScheduledPaymentsAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT entry.id, debt.id, debt.name, entry.entry_type, entry.amount_czk,
              entry.effective_at, true,
              entry.effective_at <= (CURRENT_TIMESTAMP AT TIME ZONE household.time_zone)::date,
              entry.note
            FROM debt_entries entry
            JOIN debts debt ON debt.household_id = entry.household_id AND debt.id = entry.debt_id
            JOIN households household ON household.id = entry.household_id
            WHERE entry.household_id = @household_id AND debt.owner_user_id = @user_id
              AND debt.archived_at IS NULL AND entry.entry_type = 'scheduled_payment'
            ORDER BY entry.effective_at, entry.id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var entries = new List<DebtEntryResponse>();
        while (await reader.ReadAsync(cancellationToken))
            entries.Add(new DebtEntryResponse(
                reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
                reader.GetDecimal(4), DateOnly.FromDateTime(reader.GetDateTime(5)), reader.GetBoolean(6),
                reader.GetBoolean(7), reader.IsDBNull(8) ? null : reader.GetString(8)));
        return entries;
    }
}
