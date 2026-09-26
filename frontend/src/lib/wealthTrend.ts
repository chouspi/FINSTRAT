export type WealthTrendInput = {
  date: string;
  quality?: "complete" | "estimated";
  grossAssetsCzk: number;
  btcQuantity?: number;
  btcPriceCzk?: number;
  btcCostBasisCzk: number;
  vwceShares?: number;
  vwcePriceCzk?: number;
  vwceCostBasisCzk: number;
  trackedNetWorthCzk?: number;
  consumerDebtCzk?: number;
};

export type ScheduledDebtPayment = { effectiveAt: string; amountCzk: number };
export type WealthTrendPoint = { date: string; portfolioCzk: number; investedCzk: number; netWorthCzk: number; debtCzk: number };
export type WealthTrend = {
  history: WealthTrendPoint[];
  projection: WealthTrendPoint[];
  annualContributionCzk: number;
  annualGrowthPercent: number;
  observationDays: number;
  hasReliableHistory: boolean;
  minimumHistoryDays: number;
};

const DAY_MS = 86_400_000;
const MIN_TREND_DAYS = 30;
const LOOKBACK_DAYS = 365;
const YEAR_DAYS = 365.25;
const RECENCY_DECAY = Math.LN2 / 90;

export function calculateWealthTrend(
  points: WealthTrendInput[],
  years: 1 | 2 | 5,
  scheduledDebtPayments: ScheduledDebtPayment[] = [],
): WealthTrend | null {
  const normalized = points
    .filter(validPoint)
    .map((point) => ({
      date: point.date,
      quality: point.quality ?? "complete",
      portfolioCzk: point.grossAssetsCzk,
      investedCzk: point.btcCostBasisCzk + point.vwceCostBasisCzk,
      netWorthCzk: Number.isFinite(point.trackedNetWorthCzk) ? point.trackedNetWorthCzk! : point.grossAssetsCzk,
      debtCzk: Number.isFinite(point.consumerDebtCzk) ? Math.max(0, point.consumerDebtCzk!) : 0,
      btcQuantity: point.btcQuantity,
      btcPriceCzk: point.btcPriceCzk,
      vwceShares: point.vwceShares,
      vwcePriceCzk: point.vwcePriceCzk,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const history = Array.from(new Map(normalized.map((point) => [point.date, point])).values());
  if (history.length < 2) return null;

  const last = history.at(-1)!;
  // Calibrate only from this portfolio's complete snapshots over the last year.
  const complete = history.filter((point) => point.quality === "complete"
    && daysBetween(point.date, last.date) <= LOOKBACK_DAYS);
  let observationDays = 0;
  let weightedDays = 0;
  let weightedFlows = 0;
  let weightedLogReturns = 0;
  let returnWeightedDays = 0;
  let returnDays = 0;
  for (let index = 1; index < complete.length; index++) {
    const previous = complete[index - 1];
    const current = complete[index];
    const days = daysBetween(previous.date, current.date);
    const flow = estimateExternalFlow(previous, current);
    if (flow === null || days <= 0) continue;
    // Integrate recency weights over elapsed time so sampling frequency and
    // partial calendar months don't change the contribution estimate.
    const weight = (Math.exp(-RECENCY_DECAY * daysBetween(current.date, last.date))
      - Math.exp(-RECENCY_DECAY * daysBetween(previous.date, last.date))) / RECENCY_DECAY;
    observationDays += days;
    weightedDays += weight;
    weightedFlows += flow / days * weight;

    // Modified Dietz: remove net purchases/sales from the change in value.
    // Snapshots don't record trade timing, so assume flows occur mid-interval.
    const capital = previous.portfolioCzk + flow / 2;
    const gain = current.portfolioCzk - previous.portfolioCzk - flow;
    const factor = capital > 0 ? 1 + gain / capital : NaN;
    if (Number.isFinite(factor) && factor > 0) {
      weightedLogReturns += Math.log(factor) / days * weight;
      returnWeightedDays += weight;
      returnDays += days;
    }
  }
  const lastComplete = complete.at(-1);
  const hasReliableHistory = observationDays >= MIN_TREND_DAYS
    && returnDays >= MIN_TREND_DAYS
    && !!lastComplete && daysBetween(lastComplete.date, last.date) <= MIN_TREND_DAYS;
  const annualContributionCzk = hasReliableHistory ? weightedFlows / weightedDays * YEAR_DAYS : 0;
  const monthlyContributionCzk = annualContributionCzk / 12;
  const dailyLogReturn = hasReliableHistory ? weightedLogReturns / returnWeightedDays : 0;
  const annualGrowthPercent = Math.expm1(dailyLogReturn * YEAR_DAYS) * 100;

  const projection: WealthTrendPoint[] = [last];
  let portfolioCzk = last.portfolioCzk;
  let investedCzk = last.investedCzk;
  let debtCzk = last.debtCzk;
  const payments = scheduledDebtPayments
    .filter((payment) => validDate(payment.effectiveAt) && payment.effectiveAt > last.date && Number.isFinite(payment.amountCzk) && payment.amountCzk > 0)
    .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
  let paymentIndex = 0;
  for (let step = 1; step <= years * 12; step++) {
    const projectionDate = addMonths(last.date, step);
    const days = daysBetween(projection.at(-1)!.date, projectionDate);
    const halfPeriodGrowth = Math.exp(dailyLogReturn * days / 2);
    const valueBeforeFlow = portfolioCzk * halfPeriodGrowth;
    const contribution = Math.max(-valueBeforeFlow, monthlyContributionCzk);
    // New money participates in growth from the middle of each projected month.
    portfolioCzk = Math.max(0, (valueBeforeFlow + contribution) * halfPeriodGrowth);
    investedCzk = contribution >= 0 ? investedCzk + contribution
      : valueBeforeFlow > 0 ? investedCzk * (1 + contribution / valueBeforeFlow) : 0;
    let scheduledPaymentCzk = 0;
    while (paymentIndex < payments.length && payments[paymentIndex].effectiveAt <= projectionDate) {
      scheduledPaymentCzk += payments[paymentIndex].amountCzk;
      paymentIndex++;
    }
    debtCzk = Math.max(0, debtCzk - scheduledPaymentCzk);
    projection.push({ date: projectionDate, portfolioCzk, investedCzk, netWorthCzk: portfolioCzk - debtCzk, debtCzk });
  }
  return { history, projection, annualContributionCzk, annualGrowthPercent, observationDays, hasReliableHistory, minimumHistoryDays: MIN_TREND_DAYS };
}

function validPoint(point: WealthTrendInput) {
  return validDate(point.date)
    && [point.grossAssetsCzk, point.btcCostBasisCzk, point.vwceCostBasisCzk].every(Number.isFinite)
    && point.grossAssetsCzk >= 0;
}

function validDate(value: string) {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function estimateExternalFlow(previous: { btcQuantity?: number; btcPriceCzk?: number; vwceShares?: number; vwcePriceCzk?: number }, current: { btcQuantity?: number; btcPriceCzk?: number; vwceShares?: number; vwcePriceCzk?: number }) {
  const assetFlow = (before?: number, after?: number, beforePrice?: number, afterPrice?: number) => {
    if (![before, after].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
    // Unheld assets have no price in persisted snapshots; they need no price.
    if (before === 0 && after === 0) return 0;
    if ((before! > 0 && !(Number.isFinite(beforePrice) && beforePrice! > 0))
      || (after! > 0 && !(Number.isFinite(afterPrice) && afterPrice! > 0))) return null;
    const price = before === 0 ? afterPrice! : after === 0 ? beforePrice! : (beforePrice! + afterPrice!) / 2;
    return (after! - before!) * price;
  };
  const btc = assetFlow(previous.btcQuantity, current.btcQuantity, previous.btcPriceCzk, current.btcPriceCzk);
  const vgla = assetFlow(previous.vwceShares, current.vwceShares, previous.vwcePriceCzk, current.vwcePriceCzk);
  return btc === null || vgla === null ? null : btc + vgla;
}

function daysBetween(first: string, last: string) {
  return Math.max(0, (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS);
}

function addMonths(isoDate: string, months: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
