namespace Finstrat.Api.Modules.Bitcoin;

public sealed record BitcoinOverviewResponse(
    BitcoinTotalsResponse Totals,
    IReadOnlyList<BitcoinAccountResponse> Accounts,
    IReadOnlyList<BitcoinMovementResponse> RecentMovements);

public sealed record BitcoinTotalsResponse(
    decimal QuantityBtc,
    decimal CostBasisCzk,
    int AccountCount,
    bool CostBasisComplete);

public sealed record BitcoinAccountResponse(
    Guid Id,
    string Name,
    string? Description,
    string OwnerDisplayName,
    decimal QuantityBtc,
    decimal CostBasisCzk,
    bool CostBasisComplete,
    int LotCount,
    int DisposalCount,
    int ProofCount,
    DateTime? LatestActivityAt);

public sealed record BitcoinMovementResponse(
    Guid Id,
    Guid AccountId,
    string AccountName,
    string Type,
    decimal QuantityBtc,
    decimal? UnitPriceCzk,
    DateTime OccurredAt,
    string? Txid,
    string? Note);
