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
    DateTime? LatestActivityAt,
    bool IsOwnedByCurrentUser,
    bool CanManage,
    bool CanShareWithDefault,
    bool IsSharedWithDefault,
    IReadOnlyList<BitcoinProofResponse> Proofs);

public sealed record BitcoinProofResponse(
    Guid Id,
    string? Note,
    string Sha256,
    DateTime CreatedAt,
    DateTime? AnchoredAt);

public sealed record BitcoinProofDetailResponse(
    Guid Id,
    string Content,
    long ContentSizeBytes,
    string Sha256,
    string? AnchorTxid,
    DateTime? AnchoredAt,
    string? Note,
    DateTime CreatedAt);
public sealed record SaveBitcoinProofRequest(
    string Content,
    string? AnchorTxid,
    string? AnchoredAt,
    string? Note);

public sealed record BitcoinMovementResponse(
    Guid Id,
    Guid AccountId,
    string AccountName,
    string Type,
    decimal QuantityBtc,
    decimal? UnitPriceCzk,
    DateTime OccurredAt,
    string? Txid,
    string? Note,
    bool CanEdit,
    bool CanDelete);

public sealed record UpdateBitcoinPurchaseMovementRequest(
    string QuantityBtc,
    string UnitPriceCzk,
    string AcquiredAt,
    string? Txid,
    string? Note);

public sealed record CreateBitcoinAccountRequest(string Name, string? Description);
public sealed record CreateBitcoinAccountResponse(Guid Id, string Name, string? Description);
public sealed record UpdateBitcoinAccountRequest(string Name);
public sealed record UpdateBitcoinAccountResponse(Guid Id, string Name);
public sealed record SetBitcoinDefaultShareRequest(bool Shared);

public sealed record CreateBitcoinPurchaseRequest(
    Guid AccountId,
    string QuantityBtc,
    string UnitPriceCzk,
    string AcquiredAt,
    string? Txid,
    string? Note);
public sealed record CreateBitcoinPurchaseResponse(
    Guid Id,
    Guid AccountId,
    decimal QuantityBtc,
    decimal UnitPriceCzk,
    DateTime AcquiredAt);

public sealed record CreateBitcoinWithdrawalRequest(
    Guid AccountId,
    string QuantityBtc,
    string? UnitPriceCzk,
    string WithdrawnAt,
    string? Txid,
    string? Note,
    string? Purpose,
    string? LifeExpenseCategory);
public sealed record CreateBitcoinWithdrawalResponse(
    Guid Id,
    Guid AccountId,
    decimal QuantityBtc,
    decimal? UnitPriceCzk,
    DateTime WithdrawnAt);

public sealed record CreateBitcoinTransferRequest(
    Guid FromAccountId,
    Guid ToAccountId,
    string GrossQuantityBtc,
    string? FeeQuantityBtc,
    string TransferredAt,
    string? Txid,
    string? Note);

public sealed record CreateBitcoinTransferResponse(
    Guid Id,
    Guid FromAccountId,
    Guid ToAccountId,
    decimal GrossQuantityBtc,
    decimal FeeQuantityBtc,
    decimal NetQuantityBtc,
    DateTime TransferredAt);
