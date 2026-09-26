/** A multi-day snapshot gap supplies an average, never a known deposit date. */
export type DailyCashFlow = { date: string; amount: number; observed: boolean };
export type CashFlowPattern = "daily" | "weekly" | "monthly";
const DAY = 86_400_000;
const DECAY = Math.LN2 / 90;
const age = (date: string, anchor: string) => (Date.parse(anchor) - Date.parse(date)) / DAY;
const bucket = (date: string, pattern: CashFlowPattern) => {
  const day = new Date(`${date}T00:00:00Z`);
  if (pattern === "weekly") return day.getUTCDay();
  // Treat February 28/29 and other month ends as the same payday.
  const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
  return day.getUTCDate() === end ? 31 : day.getUTCDate();
};

function average(samples: DailyCashFlow[], anchor: string) {
  let positive = 0, negative = 0, weight = 0;
  for (const sample of samples) {
    const w = Math.exp(-DECAY * age(sample.date, anchor));
    positive += Math.max(0, sample.amount) * w;
    negative += Math.max(0, -sample.amount) * w;
    weight += w;
  }
  return { positive: weight ? positive / weight : 0, negative: weight ? negative / weight : 0, weight };
}

function fit(samples: DailyCashFlow[], anchor: string, pattern: CashFlowPattern) {
  const mean = average(samples, anchor);
  const groups = new Map<number, DailyCashFlow[]>();
  for (const sample of samples.filter((s) => s.observed)) {
    const key = bucket(sample.date, pattern);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const profiles = new Map([...groups].map(([key, values]) => {
    const group = average(values, anchor);
    // One average day of prior evidence prevents a single occurrence from
    // establishing an exact recurring payday, especially in a short history.
    return [key, {
      positive: (group.positive * group.weight + mean.positive) / (group.weight + 1),
      negative: (group.negative * group.weight + mean.negative) / (group.weight + 1),
    }];
  }));
  return (date: string) => pattern === "daily" ? mean : profiles.get(bucket(date, pattern)) ?? mean;
}

export function createCashFlowForecast(samples: DailyCashFlow[], anchor: string) {
  let pattern: CashFlowPattern = "daily";
  let bestImprovement = 0.1;
  const known = samples.filter((s) => s.observed);
  // Rolling-origin validation: each prediction sees only older observations.
  // Require two training cycles and at least one later cycle to validate.
  for (const candidate of ["weekly", "monthly"] as const) {
    const trainingDays = candidate === "weekly" ? 14 : 60;
    const validationDays = candidate === "weekly" ? 14 : 30;
    let baselineError = 0, candidateError = 0, count = 0;
    for (let index = 0; index < known.length; index++) {
      const sample = known[index];
      const pastKnown = known.slice(0, index);
      if (pastKnown.length < trainingDays) continue;
      const past = samples.filter((s) => s.date < sample.date);
      const baseline = average(past, sample.date);
      const estimate = fit(past, sample.date, candidate)(sample.date);
      const weight = Math.exp(-DECAY * age(sample.date, anchor));
      baselineError += (sample.amount - baseline.positive + baseline.negative) ** 2 * weight;
      candidateError += (sample.amount - estimate.positive + estimate.negative) ** 2 * weight;
      count++;
    }
    // Ignore floating-point noise when the baseline is already exact.
    const improvement = baselineError > count * 1e-8 ? 1 - candidateError / baselineError : 0;
    if (count >= validationDays && improvement > bestImprovement) {
      pattern = candidate;
      bestImprovement = improvement;
    }
  }
  const mean = average(samples, anchor);
  const recent = average(samples.filter((s) => age(s.date, anchor) < 30), anchor);
  const profile = fit(samples, anchor, pattern);
  // Normalize a full future year: the calendar profile changes timing, not
  // the total inferred contribution rate (including deposits and withdrawals).
  let positiveTotal = 0, negativeTotal = 0;
  for (let day = 1; day <= 365; day++) {
    const value = profile(new Date(Date.parse(anchor) + day * DAY).toISOString().slice(0, 10));
    positiveTotal += value.positive;
    negativeTotal += value.negative;
  }
  return {
    pattern,
    observedDays: known.length,
    dailyAmount(date: string) {
      // The recent 30-day pace matters most now; its deviation from the
      // longer history decays over 90 days instead of growing indefinitely.
      const recentWeight = recent.weight ? Math.exp(-DECAY * age(anchor, date)) : 0;
      const positive = mean.positive + (recent.positive - mean.positive) * recentWeight;
      const negative = mean.negative + (recent.negative - mean.negative) * recentWeight;
      const value = profile(date);
      return (positiveTotal ? positive * value.positive / (positiveTotal / 365) : 0)
        - (negativeTotal ? negative * value.negative / (negativeTotal / 365) : 0);
    },
  };
}
