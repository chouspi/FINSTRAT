import { describe, expect, it } from "vitest";
import { calculateWealthTrend, type WealthTrendInput } from "./wealthTrend";

const point = (date: string, quantity: number, price = 100000, debt = 0): WealthTrendInput => ({
  date,
  quality: "complete",
  grossAssetsCzk: quantity * price,
  trackedNetWorthCzk: quantity * price - debt,
  consumerDebtCzk: debt,
  btcQuantity: quantity,
  btcPriceCzk: price,
  btcCostBasisCzk: quantity * price,
  vwceShares: 0,
  vwcePriceCzk: 4000,
  vwceCostBasisCzk: 0,
});

describe("calculateWealthTrend", () => {
  it("projects recurring contributions over elapsed days without counting the opening balance", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1),
      point("2026-01-31", 1.1),
      point("2026-03-02", 1.2),
      point("2026-04-01", 1.3),
    ], 1)!;

    expect(trend.hasReliableHistory).toBe(true);
    expect(trend.annualGrowthPercent).toBeCloseTo(0);
    expect(trend.annualContributionCzk).toBeCloseTo(10000 / 30 * 365.25);
    expect(trend.projection).toHaveLength(13);
    expect(trend.projection.at(-1)!.portfolioCzk).toBeCloseTo(130000 + 10000 / 30 * 365.25);
  });

  it("compounds the historical return of the held portfolio", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1, 100000),
      point("2026-01-31", 1, 110000),
      point("2026-03-02", 1, 121000),
      point("2026-04-01", 1, 133100),
    ], 1)!;

    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBeCloseTo((1.1 ** (365.25 / 30) - 1) * 100);
    expect(trend.projection.at(-1)!.portfolioCzk).toBeCloseTo(133100 * 1.1 ** (365 / 30));
  });

  it("uses a flat baseline when history is too short", () => {
    const trend = calculateWealthTrend([
      point("2026-08-24", 1),
      point("2026-08-25", 1.1),
    ], 1)!;

    expect(trend.hasReliableHistory).toBe(false);
    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.projection.at(-1)!.portfolioCzk).toBeCloseTo(110000);
  });

  it("applies only future scheduled debt payments", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 2, 100000, 100000),
      point("2026-02-01", 2, 100000, 100000),
    ], 1, [
      { effectiveAt: "2026-01-15", amountCzk: 90000 },
      { effectiveAt: "2026-03-15", amountCzk: 30000 },
    ])!;

    expect(trend.projection[1].debtCzk).toBe(100000);
    expect(trend.projection[2].debtCzk).toBe(70000);
  });

  it("ignores invalid and estimated observations during calibration", () => {
    const trend = calculateWealthTrend([
      point("invalid", 50),
      point("2026-01-01", 1),
      { ...point("2026-02-01", 9), quality: "estimated" },
      point("2026-03-01", 1),
      point("2026-04-01", 1),
    ], 1)!;

    expect(trend.history).toHaveLength(4);
    expect(trend.annualContributionCzk).toBe(0);
  });
  it("separates deposits from gains and compounds new contributions", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1, 100000),
      point("2026-01-31", 1.2, 110000),
    ], 1)!;
    const flow = 0.2 * 105000;
    const factor = 1 + (132000 - 100000 - flow) / (100000 + flow / 2);
    expect(trend.annualContributionCzk).toBeCloseTo(flow / 30 * 365.25);
    expect(trend.annualGrowthPercent).toBeCloseTo((factor ** (365.25 / 30) - 1) * 100);
    expect(trend.projection[1].portfolioCzk).toBeCloseTo(
      (132000 * factor ** (28 / 60) + trend.annualContributionCzk / 12) * factor ** (28 / 60),
    );
  });

  it("preserves negative returns instead of imposing positive market assumptions", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1, 100000), point("2026-01-31", 1, 90000),
    ], 1)!;
    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBeLessThan(0);
    expect(trend.projection.at(-1)!.portfolioCzk).toBeCloseTo(90000 * 0.9 ** (365 / 30));
  });

  it("uses the portfolio mix and excludes cost-basis currency changes from contributions", () => {
    const first = { ...point("2026-01-01", 1), vwceShares: 10, vwcePriceCzk: 10000, grossAssetsCzk: 200000 };
    const last = { ...point("2026-01-31", 1, 110000), vwceShares: 10, vwcePriceCzk: 9000, grossAssetsCzk: 200000, vwceCostBasisCzk: 123000 };
    const trend = calculateWealthTrend([first, last], 1)!;
    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.projection.at(-1)!.portfolioCzk).toBe(200000);
  });

  it("gives recent contribution changes more weight and ignores history older than a year", () => {
    const recent = [point("2026-01-01", 1), point("2026-04-01", 1), point("2026-06-30", 1.3)];
    const trend = calculateWealthTrend(recent, 1)!;
    expect(trend.annualContributionCzk).toBeCloseTo(30000 / 90 * 2 / 3 * 365.25);
    expect(calculateWealthTrend([point("2020-01-01", 100), ...recent], 1)!.annualContributionCzk)
      .toBeCloseTo(trend.annualContributionCzk);
  });

  it("accounts for quiet periods with no deposits", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1), point("2026-04-01", 1.3), point("2026-06-30", 1.3),
    ], 1)!;
    expect(trend.annualContributionCzk).toBeCloseTo(30000 / 90 / 3 * 365.25);
  });

  it("projects withdrawals and stops at an empty portfolio", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1), point("2026-01-31", 0.5),
    ], 5)!;
    expect(trend.annualContributionCzk).toBeLessThan(0);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.projection.at(-1)!.portfolioCzk).toBe(0);
    expect(trend.projection.every((p) => p.portfolioCzk >= 0 && p.investedCzk >= 0)).toBe(true);
  });

  it("does not halve first purchases when the previously unheld asset has no price", () => {
    const trend = calculateWealthTrend([
      { ...point("2026-01-01", 0, 0), vwcePriceCzk: 0 },
      { ...point("2026-01-31", 1), vwcePriceCzk: 0 },
    ], 1)!;
    expect(trend.annualContributionCzk).toBeCloseTo(100000 / 30 * 365.25);
    expect(trend.annualGrowthPercent).toBe(0);
  });

  it("does not interpret missing flow data as zero deposits", () => {
    const trend = calculateWealthTrend([
      { ...point("2026-01-01", 1), btcQuantity: undefined }, point("2026-04-01", 2),
    ], 1)!;
    expect(trend.hasReliableHistory).toBe(false);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.annualContributionCzk).toBe(0);
  });

  it("sorts, deduplicates, rejects impossible dates and handles month ends", () => {
    const trend = calculateWealthTrend([
      point("2026-02-30", 5), point("2026-01-31", 1), point("2026-01-01", 1), point("2026-01-31", 1.1),
    ], 1)!;
    expect(trend.history).toHaveLength(2);
    expect(trend.projection[0].portfolioCzk).toBeCloseTo(110000);
    expect(trend.projection[1].date).toBe("2026-02-28");
    expect(trend.projection[2].date).toBe("2026-03-31");
  });

  it("projects 33 days of inflows even with fewer than 30 days of returns", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 0, 0),
      point("2026-01-08", 0, 0),
      point("2026-02-03", 1),
    ], 1)!;
    expect(trend.observationDays).toBe(33);
    expect(trend.returnObservationDays).toBe(26);
    expect(trend.contributionStatus).toBe("ready");
    expect(trend.growthStatus).toBe("short");
    expect(trend.annualContributionCzk).toBeGreaterThan(0);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.projection.at(-1)!.portfolioCzk)
      .toBeCloseTo(100000 + trend.annualContributionCzk);
  });

  it("distinguishes stale observations from insufficient history", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1), point("2026-02-03", 1.1),
      { ...point("2026-03-10", 1.2), quality: "estimated" },
    ], 1)!;
    expect(trend.observationDays).toBe(33);
    expect(trend.returnObservationDays).toBe(33);
    expect(trend.contributionStatus).toBe("stale");
    expect(trend.growthStatus).toBe("stale");
    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBe(0);
  });

});
