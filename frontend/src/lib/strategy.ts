export type StrategySettings = {
  btcTaxPeriodYears: number
  checkpointTriggerFloorCzk: number
  checkpointTriggerPercent: number
  realizationStepProfitCzk: number
  realizationStepTransferCzk: number
  vwceRentRatePercent: number
}

export type StrategyOverview = {
  settings: StrategySettings
  btcQuantity: number
  btcPriceCzk: number
  portfolioValueCzk: number
  checkpointActive: boolean
  checkpointValueCzk: number | null
  profitCzk: number
  profitPercent: number
  triggerCzk: number
  progressPercent: number
  remainingCzk: number
  recommendedTransferCzk: number
  recommendation: 'DRŽET' | 'PRODAT'
}
