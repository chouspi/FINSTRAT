namespace Finstrat.Api.Modules.Vwce;

public sealed record VwceOverviewResponse(
    VwceTotalsResponse Totals,
    IReadOnlyList<VwceAccountResponse> Accounts,
    IReadOnlyList<VwceMovementResponse> RecentMovements);

public sealed record VwceTotalsResponse(
    decimal Shares,
    decimal CostBasisCzk,
    int AccountCount,
    bool CostBasisComplete,
    int ProvisionalLotCount,
    decimal RentRatePercent);

public sealed record VwceAccountResponse(
    Guid Id,
    string Name,
    string? Description,
    string OwnerDisplayName,
    decimal Shares,
    decimal CostBasisCzk,
    bool CostBasisComplete,
    int LotCount,
    int DisposalCount,
    int ProvisionalLotCount,
    DateTime? LatestActivityAt,
    bool IsOwnedByCurrentUser,
    bool CanManage,
    bool CanShareWithDefault,
    bool IsSharedWithDefault);

public sealed record VwceMovementResponse(
    Guid Id,
    Guid AccountId,
    string AccountName,
    string Type,
    decimal Shares,
    decimal? UnitPriceCzk,
    decimal? ProceedsCzk,
    DateTime OccurredAt,
    string? Note,
    bool CanEdit,
    bool CanDelete);

public sealed record UpdateVwcePurchaseMovementRequest(
    string Shares,
    string UnitPriceCzk,
    string AcquiredAt,
    string? Note);
public sealed record CreateVwcePurchaseRequest(
    string Shares,
    string UnitPriceCzk,
    string AcquiredAt,
    string? Note,
    bool ConsumeDeferredVwce = false,
    string? DeferredVwceAmountCzk = null);
public sealed record CreateVwcePurchaseResponse(
    Guid Id,
    Guid AccountId,
    decimal Shares,
    decimal UnitPriceCzk,
    DateTime AcquiredAt,
    string? Note,
    decimal DeferredVwceConsumedCzk = 0,
    decimal DeferredVwceRemainingCzk = 0);

public sealed record CreateVwceAccountRequest(string Name, string? Description);
public sealed record CreateVwceAccountResponse(Guid Id, string Name, string? Description);
public sealed record UpdateVwceAccountRequest(string Name, string? Description);
public sealed record UpdateVwceAccountResponse(Guid Id, string Name, string? Description);
public sealed record SetVwceDefaultShareRequest(bool Shared);

public sealed record CreateVwcePayoutRequest(
    Guid AccountId,
    string AmountCzk,
    string PaidAt,
    string? Note);

public sealed record CreateVwcePayoutResponse(
    Guid Id,
    Guid AccountId,
    decimal AmountCzk,
    decimal Shares,
    decimal UnitPriceCzk,
    DateTime PaidAt,
    string Note);
