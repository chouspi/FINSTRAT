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
};

const DAY_MS = 86_400_000;
const MIN_TREND_DAYS = 90;
const MIN_OBSERVED_MONTHS = 3;

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

  const complete = history.filter((point) => point.quality === "complete");
  const first = complete[0];
  const lastComplete = complete.at(-1);
  const observationDays = first && lastComplete ? daysBetween(first.date, lastComplete.date) : 0;
  const monthlyFlows = new Map<string, number>();
  let validFlowIntervals = 0;
  for (let index = 1; index < complete.length; index++) {
    const flow = estimateExternalFlow(complete[index - 1], complete[index]);
    if (flow === null) continue;
    const month = complete[index].date.slice(0, 7);
    monthlyFlows.set(month, (monthlyFlows.get(month) ?? 0) + flow);
    validFlowIntervals++;
  }

  const observedMonths = first && lastComplete ? monthsBetween(first.date, lastComplete.date) + 1 : 0;
  const monthlyTotals = first && lastComplete
    ? Array.from({ length: observedMonths }, (_, index) => monthlyFlows.get(addMonths(first.date.slice(0, 7) + "-01", index).slice(0, 7)) ?? 0)
    : [];
  const hasReliableHistory = observationDays >= MIN_TREND_DAYS
    && observedMonths >= MIN_OBSERVED_MONTHS
    && validFlowIntervals >= MIN_OBSERVED_MONTHS;
  const monthlyContributionCzk = hasReliableHistory ? winsorizedMean(monthlyTotals) : 0;
  const annualContributionCzk = monthlyContributionCzk * 12;

  const last = history.at(-1)!;
  const projection: WealthTrendPoint[] = [last];
  let portfolioCzk = last.portfolioCzk;
  let investedCzk = last.investedCzk;
  let debtCzk = last.debtCzk;
  const payments = scheduledDebtPayments
    .filter((payment) => validDate(payment.effectiveAt) && payment.effectiveAt > last.date && Number.isFinite(payment.amountCzk) && payment.amountCzk > 0)
    .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
  let paymentIndex = 0;
  for (let step = 1; step <= years * 12; step++) {
    portfolioCzk = Math.max(0, portfolioCzk + monthlyContributionCzk);
    investedCzk = Math.max(0, investedCzk + monthlyContributionCzk);
    const projectionDate = addMonths(last.date, step);
    let scheduledPaymentCzk = 0;
    while (paymentIndex < payments.length && payments[paymentIndex].effectiveAt <= projectionDate) {
      scheduledPaymentCzk += payments[paymentIndex].amountCzk;
      paymentIndex++;
    }
    debtCzk = Math.max(0, debtCzk - scheduledPaymentCzk);
    projection.push({ date: projectionDate, portfolioCzk, investedCzk, netWorthCzk: portfolioCzk - debtCzk, debtCzk });
  }
  return { history, projection, annualContributionCzk, annualGrowthPercent: 0, observationDays, hasReliableHistory };
}

function validPoint(point: WealthTrendInput) {
  return validDate(point.date)
    && [point.grossAssetsCzk, point.btcCostBasisCzk, point.vwceCostBasisCzk].every(Number.isFinite)
    && point.grossAssetsCzk >= 0;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function estimateExternalFlow(previous: { btcQuantity?: number; btcPriceCzk?: number; vwceShares?: number; vwcePriceCzk?: number }, current: { btcQuantity?: number; btcPriceCzk?: number; vwceShares?: number; vwcePriceCzk?: number }) {
  const values = [previous.btcQuantity, previous.btcPriceCzk, previous.vwceShares, previous.vwcePriceCzk, current.btcQuantity, current.btcPriceCzk, current.vwceShares, current.vwcePriceCzk];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const btcMidPrice = (previous.btcPriceCzk! + current.btcPriceCzk!) / 2;
  const vglaMidPrice = (previous.vwcePriceCzk! + current.vwcePriceCzk!) / 2;
  return (current.btcQuantity! - previous.btcQuantity!) * btcMidPrice
    + (current.vwceShares! - previous.vwceShares!) * vglaMidPrice;
}

function winsorizedMean(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const lower = sorted[Math.floor((sorted.length - 1) * 0.1)];
  const upper = sorted[Math.ceil((sorted.length - 1) * 0.9)];
  return values.reduce((sum, value) => sum + Math.min(upper, Math.max(lower, value)), 0) / values.length;
}

function daysBetween(first: string, last: string) {
  return Math.max(0, (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS);
}

function monthsBetween(first: string, last: string) {
  const [firstYear, firstMonth] = first.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  return Math.max(0, (lastYear - firstYear) * 12 + lastMonth - firstMonth);
}

function addMonths(isoDate: string, months: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
