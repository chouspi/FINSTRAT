namespace Finstrat.Api.Modules.Taxes;

public sealed record TaxLotResponse(
    Guid Id, string AccountName, decimal RemainingQuantityBtc, decimal? UnitPriceCzk,
    DateOnly TaxAcquiredAt, DateOnly TimeTestDate, bool IsTimeTestSatisfied);

public sealed record DeferredVwceObligationResponse(
    Guid Id, decimal OriginalAmountCzk, decimal AllocatedAmountCzk,
    decimal CancelledAmountCzk, decimal RemainingAmountCzk,
    DateOnly DeferredAt, DateOnly? CompletedAt, string? Note);

public sealed record TaxesOverviewResponse(
    short BtcTaxPeriodYears, decimal TaxFreeBtc, decimal TaxableBtc,
    DateOnly? NextTimeTestDate, IReadOnlyList<TaxLotResponse> Lots,
    decimal DeferredVwceCzk, IReadOnlyList<DeferredVwceObligationResponse> DeferredVwceObligations,
    decimal RecommendedTransferCzk, bool CanDeferRecommendedTransfer);

public sealed record DeferRecommendedTransferRequest(string? Note);
public sealed record DeferRecommendedTransferResponse(Guid Id, decimal AmountCzk, decimal DeferredVwceCzk);
