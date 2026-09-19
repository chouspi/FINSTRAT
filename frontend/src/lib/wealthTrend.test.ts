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
  it("projects a robust recurring contribution without assuming market growth", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1),
      point("2026-02-01", 1.1),
      point("2026-03-01", 1.2),
      point("2026-04-01", 1.3),
    ], 1)!;

    expect(trend.hasReliableHistory).toBe(true);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.annualContributionCzk).toBeCloseTo(90000);
    expect(trend.projection).toHaveLength(13);
    expect(trend.projection.at(-1)!.portfolioCzk).toBeCloseTo(220000);
  });

  it("does not extrapolate historical price growth into the forecast", () => {
    const trend = calculateWealthTrend([
      point("2026-01-01", 1, 100000),
      point("2026-02-01", 1, 120000),
      point("2026-03-01", 1, 90000),
      point("2026-04-01", 1, 150000),
    ], 1)!;

    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.projection.at(-1)!.portfolioCzk).toBe(150000);
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
});
