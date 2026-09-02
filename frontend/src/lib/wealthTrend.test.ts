import { describe, expect, it } from "vitest";
import { calculateWealthTrend } from "./wealthTrend";

describe("calculateWealthTrend", () => {
  it("averages contributions in CZK and portfolio growth relatively", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2025-01-01",
          grossAssetsCzk: 100000,
          btcCostBasisCzk: 60000,
          vwceCostBasisCzk: 40000,
        },
        {
          date: "2026-01-01",
          grossAssetsCzk: 120000,
          btcCostBasisCzk: 65000,
          vwceCostBasisCzk: 45000,
        },
      ],
      1,
    )!;

    expect(trend.annualContributionCzk).toBeCloseTo(10006.64, 1);
    expect(trend.annualGrowthPercent).toBeCloseTo(10.007, 2);
    expect(trend.projection).toHaveLength(13);
    expect(trend.projection.at(-1)!.investedCzk).toBeCloseTo(120006.64, 1);
    expect(trend.projection.at(-1)!.portfolioCzk).toBeGreaterThan(141000);
  });

  it("projects the selected horizon and ignores cost-basis decreases as inflows", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2025-01-01",
          grossAssetsCzk: 100000,
          btcCostBasisCzk: 60000,
          vwceCostBasisCzk: 40000,
        },
        {
          date: "2026-01-01",
          grossAssetsCzk: 105000,
          btcCostBasisCzk: 55000,
          vwceCostBasisCzk: 40000,
        },
      ],
      5,
    )!;

    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBeCloseTo(10.007, 2);
    expect(trend.projection).toHaveLength(61);
    expect(trend.projection.at(-1)!.date).toBe("2031-01-01");
  });

  it("does not annualize a purchase from an insufficient history", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2026-08-24",
          grossAssetsCzk: 0,
          btcCostBasisCzk: 0,
          vwceCostBasisCzk: 0,
        },
        {
          date: "2026-08-25",
          grossAssetsCzk: 400,
          btcCostBasisCzk: 0,
          vwceCostBasisCzk: 400,
        },
      ],
      1,
    )!;

    expect(trend.hasReliableHistory).toBe(false);
    expect(trend.observationDays).toBe(1);
    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.projection[1].portfolioCzk).toBe(400);
    expect(trend.projection[1].investedCzk).toBe(400);
  });

  it("projects net worth from portfolio growth and the observed debt trajectory", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2025-01-01",
          grossAssetsCzk: 200000,
          trackedNetWorthCzk: 100000,
          consumerDebtCzk: 100000,
          btcCostBasisCzk: 200000,
          vwceCostBasisCzk: 0,
        },
        {
          date: "2026-01-01",
          grossAssetsCzk: 220000,
          trackedNetWorthCzk: 160000,
          consumerDebtCzk: 60000,
          btcCostBasisCzk: 200000,
          vwceCostBasisCzk: 0,
        },
      ],
      1,
    )!;

    expect(trend.history.at(-1)!.netWorthCzk).toBe(160000);
    expect(trend.projection.at(-1)!.debtCzk).toBeCloseTo(60000);
    expect(trend.projection.at(-1)!.netWorthCzk).toBeCloseTo(
      trend.projection.at(-1)!.portfolioCzk - 60000,
    );
  });

  it("uses holding changes instead of cost-basis corrections as external cash flow", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2025-01-01",
          grossAssetsCzk: 100000,
          btcQuantity: 1,
          btcPriceCzk: 100000,
          btcCostBasisCzk: 80000,
          vwceShares: 0,
          vwcePriceCzk: 4000,
          vwceCostBasisCzk: 0,
        },
        {
          date: "2026-01-01",
          grossAssetsCzk: 100000,
          btcQuantity: 1,
          btcPriceCzk: 100000,
          btcCostBasisCzk: 90000,
          vwceShares: 0,
          vwcePriceCzk: 4000,
          vwceCostBasisCzk: 0,
        },
      ],
      1,
    )!;

    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.projection.at(-1)!.portfolioCzk).toBeCloseTo(100000);
  });

  it("removes a disposal from measured portfolio performance", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2025-01-01",
          grossAssetsCzk: 100000,
          btcQuantity: 1,
          btcPriceCzk: 100000,
          btcCostBasisCzk: 80000,
          vwceShares: 0,
          vwcePriceCzk: 4000,
          vwceCostBasisCzk: 0,
        },
        {
          date: "2026-01-01",
          grossAssetsCzk: 50000,
          btcQuantity: 0.5,
          btcPriceCzk: 100000,
          btcCostBasisCzk: 40000,
          vwceShares: 0,
          vwcePriceCzk: 4000,
          vwceCostBasisCzk: 0,
        },
      ],
      1,
    )!;

    expect(trend.annualContributionCzk).toBe(0);
    expect(trend.annualGrowthPercent).toBe(0);
    expect(trend.projection[1].portfolioCzk).toBeCloseTo(50000);
  });

  it("applies scheduled consumer-debt payments once on their effective month", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2025-01-01",
          grossAssetsCzk: 200000,
          consumerDebtCzk: 100000,
          btcCostBasisCzk: 200000,
          vwceCostBasisCzk: 0,
        },
        {
          date: "2026-01-01",
          grossAssetsCzk: 200000,
          consumerDebtCzk: 100000,
          btcCostBasisCzk: 200000,
          vwceCostBasisCzk: 0,
        },
      ],
      1,
      [
        { effectiveAt: "2026-02-01", amountCzk: 20000 },
        { effectiveAt: "2026-03-15", amountCzk: 30000 },
      ],
    )!;

    expect(trend.projection[1].debtCzk).toBe(80000);
    expect(trend.projection[2].debtCzk).toBe(80000);
    expect(trend.projection[3].debtCzk).toBe(50000);
    expect(trend.projection.at(-1)!.netWorthCzk).toBe(150000);
  });

  it("ignores estimated snapshots when calibrating the trend", () => {
    const trend = calculateWealthTrend(
      [
        {
          date: "2025-01-01",
          quality: "complete",
          grossAssetsCzk: 100000,
          btcCostBasisCzk: 100000,
          vwceCostBasisCzk: 0,
        },
        {
          date: "2025-06-01",
          quality: "estimated",
          grossAssetsCzk: 50000,
          btcCostBasisCzk: 100000,
          vwceCostBasisCzk: 0,
        },
        {
          date: "2026-01-01",
          quality: "complete",
          grossAssetsCzk: 100000,
          btcCostBasisCzk: 100000,
          vwceCostBasisCzk: 0,
        },
      ],
      1,
    )!;

    expect(trend.annualGrowthPercent).toBe(0);
  });
});
