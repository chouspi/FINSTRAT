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

export type ScheduledDebtPayment = {
  effectiveAt: string;
  amountCzk: number;
};

export type WealthTrendPoint = {
  date: string;
  portfolioCzk: number;
  investedCzk: number;
  netWorthCzk: number;
  debtCzk: number;
};

export type WealthTrend = {
  history: WealthTrendPoint[];
  projection: WealthTrendPoint[];
  annualContributionCzk: number;
  annualGrowthPercent: number;
  observationDays: number;
  hasReliableHistory: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.2425;
const MIN_TREND_DAYS = 30;

export function calculateWealthTrend(
  points: WealthTrendInput[],
  years: 1 | 2 | 5,
  scheduledDebtPayments: ScheduledDebtPayment[] = [],
): WealthTrend | null {
  const normalized = points
    .filter((point) => Number.isFinite(point.grossAssetsCzk))
    .map((point) => ({
      date: point.date,
      quality: point.quality ?? "complete",
      portfolioCzk: point.grossAssetsCzk,
      investedCzk: point.btcCostBasisCzk + point.vwceCostBasisCzk,
      netWorthCzk: Number.isFinite(point.trackedNetWorthCzk)
        ? point.trackedNetWorthCzk!
        : point.grossAssetsCzk,
      debtCzk: Number.isFinite(point.consumerDebtCzk)
        ? Math.max(0, point.consumerDebtCzk!)
        : 0,
      btcQuantity: point.btcQuantity,
      btcPriceCzk: point.btcPriceCzk,
      vwceShares: point.vwceShares,
      vwcePriceCzk: point.vwcePriceCzk,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const history = Array.from(
    new Map(normalized.map((point) => [point.date, point])).values(),
  );
  if (history.length < 2) return null;

  const completeHistory = history.filter((point) => point.quality === "complete");
  const calibration = completeHistory.length >= 2 ? completeHistory : [];
  const firstCalibration = calibration[0];
  const lastCalibration = calibration.at(-1);
  const observationDays =
    firstCalibration && lastCalibration
      ? daysBetween(firstCalibration.date, lastCalibration.date)
      : 0;
  const hasReliableHistory = observationDays >= MIN_TREND_DAYS;

  let netFlowCzk = 0;
  let growthLog = 0;
  let growthDays = 0;
  for (let index = 1; index < calibration.length; index++) {
    const previous = calibration[index - 1];
    const current = calibration[index];
    const flow = estimateExternalFlow(previous, current);
    netFlowCzk += flow;
    const contributionAdjustedValue = current.portfolioCzk - flow;
    if (previous.portfolioCzk > 0 && contributionAdjustedValue > 0) {
      growthLog += Math.log(contributionAdjustedValue / previous.portfolioCzk);
      growthDays += daysBetween(previous.date, current.date);
    }
  }

  const annualContributionCzk = hasReliableHistory
    ? (Math.max(0, netFlowCzk) / observationDays) * DAYS_PER_YEAR
    : 0;
  const monthlyContributionCzk = annualContributionCzk / 12;
  const rawAnnualGrowth =
    hasReliableHistory && growthDays > 0
      ? Math.exp((growthLog / growthDays) * DAYS_PER_YEAR) - 1
      : 0;
  const annualGrowth = Math.max(-0.9, Math.min(2, rawAnnualGrowth));
  const monthlyGrowth = Math.exp(Math.log1p(annualGrowth) / 12) - 1;
  const last = history.at(-1)!;
  const steps = years * 12;
  const projection: WealthTrendPoint[] = [last];
  let portfolioCzk = last.portfolioCzk;
  let investedCzk = last.investedCzk;
  let debtCzk = last.debtCzk;
  const payments = scheduledDebtPayments
    .filter(
      (payment) =>
        Number.isFinite(payment.amountCzk) && payment.amountCzk > 0,
    )
    .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
  let paymentIndex = 0;
  for (let step = 1; step <= steps; step++) {
    portfolioCzk = portfolioCzk * (1 + monthlyGrowth) + monthlyContributionCzk;
    investedCzk += monthlyContributionCzk;
    const projectionDate = addMonths(last.date, step);
    let scheduledPaymentCzk = 0;
    while (
      paymentIndex < payments.length &&
      payments[paymentIndex].effectiveAt <= projectionDate
    ) {
      scheduledPaymentCzk += payments[paymentIndex].amountCzk;
      paymentIndex++;
    }
    debtCzk = Math.max(0, debtCzk - scheduledPaymentCzk);
    projection.push({
      date: projectionDate,
      portfolioCzk,
      investedCzk,
      netWorthCzk: portfolioCzk - debtCzk,
      debtCzk,
    });
  }
  return {
    history,
    projection,
    annualContributionCzk,
    annualGrowthPercent: annualGrowth * 100,
    observationDays,
    hasReliableHistory,
  };
}

function estimateExternalFlow(
  previous: {
    investedCzk: number;
    btcQuantity?: number;
    btcPriceCzk?: number;
    vwceShares?: number;
    vwcePriceCzk?: number;
  },
  current: {
    investedCzk: number;
    btcQuantity?: number;
    btcPriceCzk?: number;
    vwceShares?: number;
    vwcePriceCzk?: number;
  },
) {
  const hasHoldingData = [
    previous.btcQuantity,
    current.btcQuantity,
    current.btcPriceCzk,
    previous.vwceShares,
    current.vwceShares,
    current.vwcePriceCzk,
  ].every((value) => typeof value === "number" && Number.isFinite(value));
  if (!hasHoldingData) return current.investedCzk - previous.investedCzk;
  return (
    (current.btcQuantity! - previous.btcQuantity!) * current.btcPriceCzk! +
    (current.vwceShares! - previous.vwceShares!) * current.vwcePriceCzk!
  );
}

function daysBetween(first: string, last: string) {
  return Math.max(
    0,
    (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
      DAY_MS,
  );
}

function addMonths(isoDate: string, months: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}
