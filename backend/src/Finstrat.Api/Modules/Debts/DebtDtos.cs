namespace Finstrat.Api.Modules.Debts;

public sealed record DebtOverviewResponse(
    DebtTotalsResponse Totals,
    IReadOnlyList<DebtResponse> Debts,
    IReadOnlyList<DebtEntryResponse> RecentEntries,
    IReadOnlyList<DebtEntryResponse> ScheduledPayments);

public sealed record DebtTotalsResponse(
    decimal ActiveBalanceCzk,
    decimal RepayableBalanceCzk,
    decimal MortgageBalanceCzk,
    int ActiveCount,
    int ClosedCount);

public sealed record DebtResponse(
    Guid Id,
    string Name,
    short Priority,
    bool IsMortgage,
    DateOnly OpenedAt,
    DateOnly? ClosedAt,
    string? Note,
    decimal BalanceCzk,
    decimal ScheduledPaymentCzk,
    int EntryCount,
    DateOnly? LatestActivityAt);

public sealed record DebtEntryResponse(
    Guid Id,
    Guid DebtId,
    string DebtName,
    string Type,
    decimal AmountCzk,
    DateOnly EffectiveAt,
    bool IsScheduled,
    bool IsDue,
    string? Note);

public sealed record CreateDebtRequest(
    string Name, string OpeningBalanceCzk, short Priority, bool IsMortgage,
    string OpenedAt, string? Note);
public sealed record UpdateDebtRequest(string Name, short Priority, bool IsMortgage, string? Note);
public sealed record CreateDebtPaymentRequest(string AmountCzk, string EffectiveAt, string? Note);
public sealed record CreateDebtDrawdownRequest(string AmountCzk, string EffectiveAt, string? Note);
public sealed record DebtCommandResponse(Guid Id, decimal BalanceCzk, DateOnly? ClosedAt);
public sealed record ConfirmScheduledPaymentResponse(
    Guid DebtId, string DebtName, decimal AmountCzk, DateOnly EffectiveAt,
    DateOnly NextEffectiveAt, string? Note);
public sealed record ConfirmScheduledPaymentsResponse(
    int ConfirmedCount,
    decimal ConfirmedAmountCzk,
    IReadOnlyList<ConfirmScheduledPaymentResponse> Payments);
