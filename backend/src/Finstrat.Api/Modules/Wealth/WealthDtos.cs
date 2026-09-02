namespace Finstrat.Api.Modules.Wealth;

public sealed record WealthHistoryResponse(
    WealthSnapshotResponse? Current,
    IReadOnlyList<WealthSnapshotResponse> Points);

public sealed record WealthSnapshotResponse(
    DateOnly Date,
    DateTimeOffset SnapshotAt,
    string Quality,
    decimal BtcQuantity,
    decimal BtcPriceCzk,
    decimal BtcValueCzk,
    decimal BtcCostBasisCzk,
    decimal VwceShares,
    decimal VwcePriceCzk,
    decimal VwceValueCzk,
    decimal VwceCostBasisCzk,
    decimal ConsumerDebtCzk,
    decimal MortgageDebtCzk,
    decimal GrossAssetsCzk,
    decimal TrackedNetWorthCzk);
