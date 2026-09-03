namespace Finstrat.Api.Modules.IncomePlan;

public sealed record IncomePlanOverviewResponse(
    IncomePlanSettingsResponse Settings,
    IReadOnlyList<IncomePlanDebtResponse> Debts,
    decimal ScheduledDebtPaymentCzk,
    decimal DeferredVwceCzk);

public sealed record IncomePlanSettingsResponse(
    decimal DefaultCapitalCzk,
    decimal WithoutDebtBtcPercent,
    decimal WithoutDebtCashPercent,
    decimal WithDebtBtcPercent,
    decimal WithDebtDebtPercent,
    decimal WithDebtCashPercent,
    decimal DeferredDebtPaymentCzk,
    string? CashAccountIban,
    string? CoinmateIban,
    string? CoinmateVariableSymbol,
    string? CoinmateRecipientMessage);

public sealed record IncomePlanDebtResponse(
    Guid Id, string Name, short Priority, decimal BalanceCzk);

public sealed record UpdateIncomePlanSettingsRequest(
    string DefaultCapitalCzk,
    decimal WithoutDebtBtcPercent,
    decimal WithoutDebtCashPercent,
    decimal WithDebtBtcPercent,
    decimal WithDebtDebtPercent,
    decimal WithDebtCashPercent,
    string? CashAccountIban,
    string? CoinmateIban,
    string? CoinmateVariableSymbol,
    string? CoinmateRecipientMessage);

public sealed record AdjustDeferredDebtPaymentRequest(
    string AmountCzk,
    string ExpectedDeferredDebtPaymentCzk);

public sealed record DeferredDebtPaymentResponse(decimal DeferredDebtPaymentCzk);
