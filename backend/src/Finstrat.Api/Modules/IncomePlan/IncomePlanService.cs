using System.Data;
using System.Globalization;
using System.Text;
using Finstrat.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Finstrat.Api.Modules.IncomePlan;

public sealed class IncomePlanService(ApplicationDbContext dbContext)
{
    private static readonly IncomePlanSettingsResponse Defaults = new(
        0, 90, 10, 70, 20, 10, 0, null, null, null, null);

    public async Task<IncomePlanOverviewResponse> GetOverviewAsync(
        Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        var shouldClose = connection.State != ConnectionState.Open;
        if (shouldClose) await connection.OpenAsync(cancellationToken);
        try
        {
            var settings = await ReadSettingsAsync(connection, householdId, userId, cancellationToken);
            var debts = await ReadDebtsAsync(connection, householdId, userId, cancellationToken);
            var scheduledDebtPayment = await ReadScheduledDebtPaymentAsync(connection, householdId, userId, cancellationToken);
            var deferredVwce = await ReadDeferredVwceAsync(connection, householdId, userId, cancellationToken);
            return new IncomePlanOverviewResponse(settings, debts, scheduledDebtPayment, deferredVwce);
        }
        finally
        {
            if (shouldClose) await connection.CloseAsync();
        }
    }

    private static async Task<decimal> ReadDeferredVwceAsync(NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT COALESCE(SUM(GREATEST(obligation.original_amount_czk-obligation.cancelled_amount_czk-COALESCE(allocated.amount_czk,0),0)),0)
            FROM deferred_vwce_obligations obligation LEFT JOIN LATERAL
              (SELECT SUM(amount_czk) amount_czk FROM deferred_vwce_allocations allocation WHERE allocation.obligation_id=obligation.id) allocated ON true
            WHERE obligation.household_id=@household_id AND obligation.owner_user_id=@user_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId); command.Parameters.AddWithValue("user_id", userId);
        return (decimal)(await command.ExecuteScalarAsync(cancellationToken) ?? 0m);
    }

    public async Task<IncomePlanSettingsResponse> UpdateAsync(
        Guid householdId, Guid userId, UpdateIncomePlanSettingsRequest request,
        CancellationToken cancellationToken)
    {
        var capital = ParseCapital(request.DefaultCapitalCzk);
        ValidatePercentages(request);
        var cashAccountIban = ValidateCzechIban(request.CashAccountIban, "hotovostního účtu");
        var coinmateIban = ValidateCzechIban(request.CoinmateIban, "Coinmate účtu");
        var coinmateVariableSymbol = ValidateCoinmateVariableSymbol(request.CoinmateVariableSymbol);
        var coinmateRecipientMessage = ValidateCoinmateRecipientMessage(request.CoinmateRecipientMessage);
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            INSERT INTO income_plan_settings (
              household_id, user_id, default_capital_czk,
              without_debt_btc_percent, without_debt_cash_percent,
              with_debt_btc_percent, with_debt_debt_percent, with_debt_cash_percent,
              cash_account_iban, coinmate_iban, coinmate_variable_symbol,
              coinmate_recipient_message
            ) VALUES (@household_id, @user_id, @capital, @without_btc, @without_cash,
              @with_btc, @with_debt, @with_cash, @cash_account_iban, @coinmate_iban,
              @coinmate_variable_symbol, @coinmate_recipient_message)
            ON CONFLICT (household_id, user_id) DO UPDATE SET
              default_capital_czk = EXCLUDED.default_capital_czk,
              without_debt_btc_percent = EXCLUDED.without_debt_btc_percent,
              without_debt_cash_percent = EXCLUDED.without_debt_cash_percent,
              with_debt_btc_percent = EXCLUDED.with_debt_btc_percent,
              with_debt_debt_percent = EXCLUDED.with_debt_debt_percent,
              with_debt_cash_percent = EXCLUDED.with_debt_cash_percent,
              cash_account_iban = EXCLUDED.cash_account_iban,
              coinmate_iban = EXCLUDED.coinmate_iban,
              coinmate_variable_symbol = EXCLUDED.coinmate_variable_symbol,
              coinmate_recipient_message = EXCLUDED.coinmate_recipient_message
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("capital", capital);
        command.Parameters.AddWithValue("without_btc", request.WithoutDebtBtcPercent);
        command.Parameters.AddWithValue("without_cash", request.WithoutDebtCashPercent);
        command.Parameters.AddWithValue("with_btc", request.WithDebtBtcPercent);
        command.Parameters.AddWithValue("with_debt", request.WithDebtDebtPercent);
        command.Parameters.AddWithValue("with_cash", request.WithDebtCashPercent);
        command.Parameters.Add("cash_account_iban", NpgsqlDbType.Varchar).Value =
            (object?)cashAccountIban ?? DBNull.Value;
        command.Parameters.Add("coinmate_iban", NpgsqlDbType.Varchar).Value =
            (object?)coinmateIban ?? DBNull.Value;
        command.Parameters.Add("coinmate_variable_symbol", NpgsqlDbType.Varchar).Value =
            (object?)coinmateVariableSymbol ?? DBNull.Value;
        command.Parameters.Add("coinmate_recipient_message", NpgsqlDbType.Varchar).Value =
            (object?)coinmateRecipientMessage ?? DBNull.Value;
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await ReadSettingsAsync(connection, householdId, userId, cancellationToken);
    }

    public async Task<DeferredDebtPaymentResponse> AdjustDeferredDebtPaymentAsync(
        Guid householdId, Guid userId, AdjustDeferredDebtPaymentRequest request, bool add,
        CancellationToken cancellationToken)
    {
        var amount = ParseCapital(request.AmountCzk);
        var expected = ParseCapital(request.ExpectedDeferredDebtPaymentCzk);
        if (amount <= 0) throw new IncomePlanValidationException("Odložená splátka musí být kladná.");
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        var sql = add ? """
            WITH adjusted AS (
              INSERT INTO income_plan_settings (household_id, user_id, deferred_debt_payment_czk)
              SELECT @household_id, @user_id, @amount WHERE @expected = 0
              ON CONFLICT (household_id, user_id) DO UPDATE SET
                deferred_debt_payment_czk = income_plan_settings.deferred_debt_payment_czk + @amount
              WHERE income_plan_settings.deferred_debt_payment_czk = @expected
              RETURNING deferred_debt_payment_czk
            ), audit AS (
              INSERT INTO audit_events (household_id, actor_user_id, event_type, entity_type, description, metadata)
              SELECT @household_id, @user_id, 'income_debt_payment_deferred', 'income_plan',
                'Debt payment deferred', jsonb_build_object('amount_czk', @amount)
              FROM adjusted
            ) SELECT deferred_debt_payment_czk FROM adjusted
            """ : """
            WITH adjusted AS (
              UPDATE income_plan_settings SET
                deferred_debt_payment_czk = deferred_debt_payment_czk - @amount
              WHERE household_id = @household_id AND user_id = @user_id
                AND deferred_debt_payment_czk = @expected
                AND deferred_debt_payment_czk >= @amount
              RETURNING deferred_debt_payment_czk
            ), audit AS (
              INSERT INTO audit_events (household_id, actor_user_id, event_type, entity_type, description, metadata)
              SELECT @household_id, @user_id, 'income_deferred_debt_payment_used', 'income_plan',
                'Deferred debt payment used', jsonb_build_object('amount_czk', @amount)
              FROM adjusted
            ) SELECT deferred_debt_payment_czk FROM adjusted
            """;
        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("amount", amount);
        command.Parameters.AddWithValue("expected", expected);
        if (await command.ExecuteScalarAsync(cancellationToken) is not decimal deferred)
            throw new IncomePlanValidationException("Odložená částka se mezitím změnila. Obnovte data a zkuste to znovu.");
        return new DeferredDebtPaymentResponse(deferred);
    }

    public async Task DeleteDeferredDebtPaymentAsync(
        Guid householdId, Guid userId, string expectedValue, CancellationToken cancellationToken)
    {
        var expected = ParseCapital(expectedValue);
        if (expected <= 0) throw new IncomePlanValidationException("Není evidována žádná odložená splátka.");
        var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            WITH deleted AS (
              UPDATE income_plan_settings SET deferred_debt_payment_czk = 0
              WHERE household_id = @household_id AND user_id = @user_id
                AND deferred_debt_payment_czk = @expected
              RETURNING deferred_debt_payment_czk
            ), audit AS (
              INSERT INTO audit_events (household_id, actor_user_id, event_type, entity_type, description, metadata)
              SELECT @household_id, @user_id, 'income_deferred_debt_payment_deleted', 'income_plan',
                'Deferred debt payment deleted', jsonb_build_object('amount_czk', @expected)
              FROM deleted
            ) SELECT deferred_debt_payment_czk FROM deleted
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        command.Parameters.AddWithValue("expected", expected);
        if (await command.ExecuteScalarAsync(cancellationToken) is not decimal)
            throw new IncomePlanValidationException("Odložená částka se mezitím změnila. Obnovte data a zkuste to znovu.");
    }

    private static async Task<IncomePlanSettingsResponse> ReadSettingsAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT default_capital_czk, without_debt_btc_percent, without_debt_cash_percent,
              with_debt_btc_percent, with_debt_debt_percent, with_debt_cash_percent,
              deferred_debt_payment_czk, cash_account_iban, coinmate_iban,
              coinmate_variable_symbol, coinmate_recipient_message
            FROM income_plan_settings WHERE household_id = @household_id AND user_id = @user_id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return Defaults;
        return new IncomePlanSettingsResponse(reader.GetDecimal(0), reader.GetDecimal(1),
            reader.GetDecimal(2), reader.GetDecimal(3), reader.GetDecimal(4), reader.GetDecimal(5),
            reader.GetDecimal(6), reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10));
    }

    private static async Task<List<IncomePlanDebtResponse>> ReadDebtsAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT debt.id, debt.name, debt.priority, balance.balance_czk
            FROM debts debt
            JOIN debt_balances balance
              ON balance.household_id = debt.household_id AND balance.debt_id = debt.id
            WHERE debt.household_id = @household_id AND debt.owner_user_id = @user_id
              AND debt.archived_at IS NULL AND debt.closed_at IS NULL
              AND NOT debt.is_mortgage AND balance.balance_czk > 0
            ORDER BY debt.priority DESC, debt.created_at, debt.id
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var debts = new List<IncomePlanDebtResponse>();
        while (await reader.ReadAsync(cancellationToken))
            debts.Add(new IncomePlanDebtResponse(reader.GetGuid(0), reader.GetString(1),
                reader.GetInt16(2), reader.GetDecimal(3)));
        return debts;
    }

    private static async Task<decimal> ReadScheduledDebtPaymentAsync(
        NpgsqlConnection connection, Guid householdId, Guid userId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT COALESCE(sum(entry.amount_czk), 0)
            FROM debt_entries entry
            JOIN debts debt
              ON debt.household_id = entry.household_id AND debt.id = entry.debt_id
            JOIN households household ON household.id = entry.household_id
            WHERE entry.household_id = @household_id AND debt.owner_user_id = @user_id
              AND debt.archived_at IS NULL AND entry.entry_type = 'scheduled_payment'
            """, connection);
        command.Parameters.AddWithValue("household_id", householdId);
        command.Parameters.AddWithValue("user_id", userId);
        return (decimal)(await command.ExecuteScalarAsync(cancellationToken) ?? 0m);
    }

    private static decimal ParseCapital(string value)
    {
        if (!decimal.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out var capital)
            || capital < 0 || decimal.Round(capital, 2) != capital)
            throw new IncomePlanValidationException("Kapitál musí být nezáporné číslo s nejvýše dvěma desetinnými místy.");
        return capital;
    }

    private static void ValidatePercentages(UpdateIncomePlanSettingsRequest request)
    {
        var values = new[] { request.WithoutDebtBtcPercent, request.WithoutDebtCashPercent,
            request.WithDebtBtcPercent, request.WithDebtDebtPercent, request.WithDebtCashPercent };
        if (values.Any(value => value is < 0 or > 100)
            || request.WithoutDebtBtcPercent + request.WithoutDebtCashPercent != 100
            || request.WithDebtBtcPercent + request.WithDebtDebtPercent + request.WithDebtCashPercent != 100)
            throw new IncomePlanValidationException("Alokace v každém režimu musí dávat přesně 100 %.");
    }

    private static string? ValidateCzechIban(string? value, string accountName)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;

        var iban = string.Concat(value.Trim().Where(character => !char.IsWhiteSpace(character)))
            .ToUpperInvariant();
        if (iban.Length != 24 || !iban.StartsWith("CZ", StringComparison.Ordinal)
            || iban[2..].Any(character => !char.IsAsciiDigit(character))
            || !HasValidIbanChecksum(iban))
            throw new IncomePlanValidationException($"IBAN {accountName} musí být platný český IBAN.");
        return iban;
    }

    private static string? ValidateCoinmateVariableSymbol(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;

        var variableSymbol = value.Trim();
        if (variableSymbol.Length is < 1 or > 10
            || variableSymbol.Any(character => !char.IsAsciiDigit(character)))
            throw new IncomePlanValidationException("Variabilní symbol Coinmate musí obsahovat 1 až 10 číslic.");
        return variableSymbol;
    }

    private static string? ValidateCoinmateRecipientMessage(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (value.Any(character => character is '\r' or '\n'))
            throw new IncomePlanValidationException(
                "Zpráva pro příjemce Coinmate smí mít nejvýše 60 běžných znaků.");

        var message = string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            .Normalize(NormalizationForm.FormC);
        if (message.Length > 60 || message.Any(character =>
                !char.IsLetterOrDigit(character)
                && character is not (' ' or '-' or '.' or ',' or '/' or '(' or ')' or '+'
                    or '\'' or ':' or '?' or '!' or '&')))
            throw new IncomePlanValidationException(
                "Zpráva pro příjemce Coinmate smí mít nejvýše 60 běžných znaků.");
        return message;
    }

    private static bool HasValidIbanChecksum(string iban)
    {
        var remainder = 0;
        foreach (var character in iban[4..] + iban[..4])
        {
            if (char.IsAsciiDigit(character))
                remainder = (remainder * 10 + character - '0') % 97;
            else
                remainder = (remainder * 100 + character - 'A' + 10) % 97;
        }
        return remainder == 1;
    }
}

public sealed class IncomePlanValidationException(string message) : Exception(message);
