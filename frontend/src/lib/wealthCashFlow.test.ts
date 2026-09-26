import { describe, expect, it } from "vitest";
import { createCashFlowForecast, type DailyCashFlow } from "./wealthCashFlow";

const dateAt = (start: string, day: number) => new Date(Date.parse(start) + day * 86400000).toISOString().slice(0, 10);
const series = (days: number, amount: (date: string, index: number) => number): DailyCashFlow[] =>
  Array.from({ length: days }, (_, index) => {
    const date = dateAt("2026-01-01", index);
    return { date, amount: amount(date, index), observed: true };
  });

describe("daily cash-flow forecasting", () => {
  it("learns weekly deposits and preserves quiet days", () => {
    const samples = series(90, (date) => new Date(date).getUTCDay() === 1 ? 7000 : 0);
    const model = createCashFlowForecast(samples, samples.at(-1)!.date);
    expect(model.pattern).toBe("weekly");
    expect(model.dailyAmount("2026-04-06")).toBeGreaterThan(model.dailyAmount("2026-04-07") * 5);
  });

  it("learns monthly paydays instead of spreading the same amount over every day", () => {
    const samples = series(181, (date) => date.endsWith("-15") ? 30000 : 0);
    const model = createCashFlowForecast(samples, samples.at(-1)!.date);
    expect(model.pattern).toBe("monthly");
    expect(model.dailyAmount("2026-07-15")).toBeGreaterThan(model.dailyAmount("2026-07-14") * 5);
  });

  it("recognizes month-end payments across February and 30/31-day months", () => {
    const samples = series(181, (date) => dateAt(date, 1).endsWith("-01") ? 30000 : 0);
    const model = createCashFlowForecast(samples, samples.at(-1)!.date);
    expect(model.pattern).toBe("monthly");
    expect(model.dailyAmount("2027-02-28")).toBeGreaterThan(model.dailyAmount("2027-02-27") * 5);
  });

  it("does not invent recurring paydays from one isolated deposit", () => {
    const samples = series(90, (_, index) => index === 40 ? 100000 : 0);
    expect(createCashFlowForecast(samples, samples.at(-1)!.date).pattern).toBe("daily");
  });

  it("does not learn calendar timing from interpolated snapshot gaps", () => {
    const samples = series(90, (date) => new Date(date).getUTCDay() === 1 ? 7000 : 0)
      .map((sample) => ({ ...sample, observed: false }));
    const model = createCashFlowForecast(samples, samples.at(-1)!.date);
    expect(model.pattern).toBe("daily");
    expect(model.observedDays).toBe(0);
  });

  it("adapts to a changed recent pace without extrapolating acceleration forever", () => {
    const samples = series(120, (_, index) => index >= 90 ? 200 : 100);
    const model = createCashFlowForecast(samples, samples.at(-1)!.date);
    expect(model.dailyAmount("2026-05-01")).toBeGreaterThan(199);
    expect(model.dailyAmount("2026-05-01")).toBeLessThan(200);
    expect(model.dailyAmount("2027-05-01")).toBeLessThan(model.dailyAmount("2026-05-01"));
    expect(model.dailyAmount("2027-05-01")).toBeGreaterThan(100);
  });

  it("handles recurring deposits and withdrawals separately even when net flow is near zero", () => {
    const samples = series(120, (date) => {
      const weekday = new Date(date).getUTCDay();
      return weekday === 1 ? 7000 : weekday === 5 ? -7000 : 0;
    });
    const model = createCashFlowForecast(samples, samples.at(-1)!.date);
    expect(model.pattern).toBe("weekly");
    expect(model.dailyAmount("2026-05-04")).toBeGreaterThan(0);
    expect(model.dailyAmount("2026-05-08")).toBeLessThan(0);
  });

  it("keeps constant daily flows and empty histories finite", () => {
    const samples = series(90, () => 100);
    const model = createCashFlowForecast(samples, samples.at(-1)!.date);
    expect(model.pattern).toBe("daily");
    expect(model.dailyAmount("2026-05-01")).toBeCloseTo(100);
    expect(createCashFlowForecast([], "2026-01-01").dailyAmount("2026-02-01")).toBe(0);
  });
});
