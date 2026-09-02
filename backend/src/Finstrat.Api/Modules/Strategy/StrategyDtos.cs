namespace Finstrat.Api.Modules.Strategy;

public sealed record StrategySettingsResponse(
    short BtcTaxPeriodYears,
    bool CheckpointAuto,
    decimal CheckpointActivationThresholdCzk,
    decimal CheckpointTriggerFloorCzk,
    decimal CheckpointTriggerPercent,
    decimal RealizationStepProfitCzk,
    decimal RealizationStepTransferCzk,
    decimal VwceRentRatePercent);

public sealed record UpdateStrategySettingsRequest(
    short BtcTaxPeriodYears,
    bool CheckpointAuto,
    decimal CheckpointActivationThresholdCzk,
    decimal CheckpointTriggerFloorCzk,
    decimal CheckpointTriggerPercent,
    decimal RealizationStepProfitCzk,
    decimal RealizationStepTransferCzk,
    decimal VwceRentRatePercent);

public sealed record StrategyOverviewResponse(
    StrategySettingsResponse Settings,
    decimal BtcQuantity,
    decimal BtcPriceCzk,
    decimal PortfolioValueCzk,
    bool CheckpointActive,
    decimal? CheckpointValueCzk,
    decimal ProfitCzk,
    decimal ProfitPercent,
    decimal TriggerCzk,
    decimal ProgressPercent,
    decimal RemainingCzk,
    decimal RecommendedTransferCzk,
    string Recommendation);
