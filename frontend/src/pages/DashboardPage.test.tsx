import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRouter } from "../router";

const point = (
  date: string,
  net: number,
  btc: number,
  vwce: number,
  debt: number,
) => ({
  date,
  snapshotAt: `${date}T21:55:00Z`,
  quality: "complete",
  btcQuantity: 0.1,
  btcPriceCzk: 3000000,
  btcValueCzk: btc,
  btcCostBasisCzk: 200000,
  vwceShares: 20,
  vwcePriceCzk: 4000,
  vwceValueCzk: vwce,
  vwceCostBasisCzk: 70000,
  consumerDebtCzk: debt,
  mortgageDebtCzk: 2500000,
  grossAssetsCzk: btc + vwce,
  trackedNetWorthCzk: net,
});

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/api/wealth/history")) {
          const points = url.includes("days=30")
            ? [
                point("2026-08-23", 300000, 320000, 80000, 100000),
                point("2026-08-24", 280000, 300000, 80000, 100000),
              ]
            : [
                point("2026-08-23", -20000, 280000, 80000, 100000),
                point("2026-08-24", 20000, 300000, 80000, 100000),
              ];
          return {
            ok: true,
            status: 200,
            json: async () => ({ current: points[1], points }),
          } as Response;
        }
        if (url.endsWith("/income-plan/overview"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              settings: {
                defaultCapitalCzk: 21600,
                withoutDebtBtcPercent: 90,
                withoutDebtCashPercent: 10,
                withDebtBtcPercent: 70,
                withDebtDebtPercent: 20,
                withDebtCashPercent: 10,
              },
              debts: [{ id: "loan", name: "Půjčka", balanceCzk: 50000 }],
              scheduledDebtPaymentCzk: 5000,
            }),
          } as Response;
        if (url.endsWith("/strategy/overview"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              settings: {
                btcTaxPeriodYears: 3,
                checkpointTriggerFloorCzk: 20000,
                checkpointTriggerPercent: 10,
                realizationStepProfitCzk: 20000,
                realizationStepTransferCzk: 10000,
                vwceRentRatePercent: 2,
              },
              btcQuantity: 0.1,
              btcPriceCzk: 3000000,
              portfolioValueCzk: 300000,
              checkpointActive: true,
              checkpointValueCzk: 250000,
              profitCzk: 50000,
              profitPercent: 20,
              triggerCzk: 25000,
              progressPercent: 100,
              remainingCzk: 0,
              recommendedTransferCzk: 20000,
              recommendation: "PRODAT",
            }),
          } as Response;
        if (url.endsWith("/bitcoin/overview"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              totals: {
                quantityBtc: 0.1,
                costBasisCzk: 200000,
                accountCount: 2,
                costBasisComplete: true,
              },
              accounts: [
                {
                  id: "ledger",
                  name: "Ledger",
                  quantityBtc: 0.06,
                  costBasisCzk: 120000,
                },
                {
                  id: "cold",
                  name: "Cold storage",
                  quantityBtc: 0.04,
                  costBasisCzk: 80000,
                },
              ],
              recentMovements: [],
            }),
          } as Response;
        if (url.endsWith("/vgla/overview"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              totals: {
                shares: 20,
                costBasisEur: 2800,
                accountCount: 1,
                costBasisComplete: true,
                provisionalLotCount: 0,
                rentRatePercent: 2,
              },
              accounts: [],
              recentMovements: [],
            }),
          } as Response;
        if (url.endsWith("/btc-price"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              priceUsd: 75000,
              priceCzk: 3000000,
              change24hPercent: 1,
            }),
          } as Response;
        if (url.endsWith("/vgla-price"))
          return {
            ok: true,
            status: 200,
            json: async () => ({ priceEur: 160, priceCzk: 4000, eurCzk: 25, isStale: false }),
          } as Response;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "default",
            userName: "default",
            displayName: "Default",
            isDefault: true,
            householdId: "household",
            role: "owner",
          }),
        } as Response;
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders tracked wealth and reloads the selected chart range", async () => {
    const user = userEvent.setup();
    const router = createTestRouter("/wealth");
    await router.load();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByRole("tab", { name: "Portfolio value" });
    const primaryValue = document.querySelector(".wealth-primary");
    expect(primaryValue).toHaveTextContent("380 000 Kč");
    expect(primaryValue).not.toHaveTextContent("HODNOTA PORTFOLIA");
    expect(primaryValue).not.toHaveTextContent("BTC a VGLA");
    expect(screen.queryByText("ALOKACE AKTIV")).not.toBeInTheDocument();
    expect(screen.getByText(/79 % portfolia/)).toBeInTheDocument();
    expect(screen.getByText(/21 % portfolia/)).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Portfolio value" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByText(/^BTC 300[  ]000[  ]Kč$/),
    ).not.toBeInTheDocument();
    const chart = screen.getByRole("img", {
      name: "Graf vývoje hodnoty portfolia a investovaných částek",
    });
    expect(chart.querySelector(".wealth-line")).toHaveClass("trend-up");
    expect(chart.querySelector(".wealth-invested-line")).toBeInTheDocument();
    expect(
      chart.parentElement!.querySelector(".wealth-tooltip"),
    ).not.toBeInTheDocument();
    vi.spyOn(chart.parentElement!, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 1000,
    } as DOMRect);
    fireEvent.pointerMove(chart.parentElement!, { clientX: 0 });
    expect(
      chart.parentElement!.querySelector(".wealth-tooltip"),
    ).toBeInTheDocument();
    fireEvent.pointerLeave(chart.parentElement!);
    expect(
      chart.parentElement!.querySelector(".wealth-tooltip"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Investováno").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("img", { name: "Graf vývoje čistého jmění" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Čisté jmění" }));
    const netWorthChart = screen.getByRole("img", {
      name: "Graf vývoje čistého jmění",
    });
    expect(
      netWorthChart.querySelector(".net-line-negative"),
    ).toBeInTheDocument();
    expect(
      netWorthChart.querySelector(".net-line-positive"),
    ).toBeInTheDocument();
    expect(netWorthChart.querySelector(".net-zero-line")).toBeInTheDocument();
    expect(
      screen.getByText(/Hypotéka .* není součástí čistého jmění/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Renta" }));
    expect(screen.getByText("VÝVOJ MĚSÍČNÍ RENTY")).toBeInTheDocument();
    const rentChart = screen.getByRole("img", {
      name: "Graf vývoje měsíční renty z VGLA",
    });
    vi.spyOn(rentChart.parentElement!, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 1000,
    } as DOMRect);
    fireEvent.pointerMove(rentChart.parentElement!, { clientX: 0 });
    expect(screen.getByText(/Měsíční renta .*Kč/)).toBeInTheDocument();
    expect(screen.getByText(/Hodnota VGLA .*Kč/)).toBeInTheDocument();
    expect(screen.getByText(/při sazbě 2 % p.a./i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1M" }));
    expect(document.querySelector(".wealth-loading")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) =>
            String(url).includes("/api/wealth/history?days=30"),
          ),
      ).toBe(true),
    );
    await user.click(screen.getByRole("tab", { name: "Portfolio value" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("img", {
            name: "Graf vývoje hodnoty portfolia a investovaných částek",
          })
          .querySelector(".wealth-line"),
      ).toHaveClass("trend-down"),
    );
    await user.click(screen.getByRole("tab", { name: "Trend" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) =>
            String(url).includes("/api/wealth/history?days=3650"),
          ),
      ).toBe(true),
    );
    const trendChart = await screen.findByRole("img", {
      name: "Graf historie a předpovědi trendu portfolia",
    });
    expect(
      trendChart.querySelector(".trend-forecast-zone"),
    ).toBeInTheDocument();
    expect(
      trendChart.querySelector(".trend-history-portfolio"),
    ).toBeInTheDocument();
    expect(
      trendChart.querySelector(".trend-projection-portfolio"),
    ).toHaveAttribute("marker-end", "url(#trend-portfolio-arrow)");
    fireEvent.pointerMove(trendChart.parentElement!, { clientX: 0 });
    expect(screen.getByText(/Historie ·/)).toBeInTheDocument();
    expect(screen.getByText(/Hodnota .*Kč/)).toBeInTheDocument();
    expect(screen.getByText(/Investováno .*Kč/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1R" })).toHaveClass("active");
    await user.click(screen.getByRole("button", { name: "5R" }));
    expect(screen.getByText("ODHAD PORTFOLIA ZA 5 LET")).toBeInTheDocument();
    await user.click(
      within(screen.getByLabelText("Veličina trendu")).getByRole("button", {
        name: "Čisté jmění",
      }),
    );
    expect(
      screen.getByText("ODHAD ČISTÉHO JMĚNÍ ZA 5 LET"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Graf historie a předpovědi trendu čistého jmění",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Odhad dluhu na konci období/)).toBeInTheDocument();
  });

  it("renders the interactive net-worth chart and reloads selected timeframes", async () => {
    const user = userEvent.setup();
    const router = createTestRouter("/");
    await router.load();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Čisté jmění" })).toBeInTheDocument();
    expect(await screen.findByText(/-?20[  ]000[  ]Kč/, { selector: ".dashboard-chart-summary strong" })).toBeInTheDocument();
    expect(document.querySelector(".dashboard-chart-summary")).toHaveClass("negative");
    expect(screen.getByText("za poslední měsíc")).toBeInTheDocument();
    const chart = await screen.findByRole("img", { name: "Vývoj čistého jmění" });
    expect(chart.querySelectorAll(".dashboard-grid-line").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector(".dashboard-chart-visual")).toHaveClass("negative");
    const chartFrame = screen.getByRole("group", { name: /Graf čistého jmění/ });
    const chartPlot = document.querySelector(".dashboard-chart-plot")!;
    vi.spyOn(chartPlot, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    fireEvent.mouseMove(chartPlot, { clientX: 0 });
    expect(document.querySelector(".dashboard-chart-tooltip")).toBeInTheDocument();
    fireEvent.keyDown(chartFrame, { key: "End" });
    expect(document.querySelector(".dashboard-active-point")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "1M" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "3M" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/wealth/history?days=90"))).toBe(true));
    expect(screen.getByText("za poslední měsíc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3M" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(document.querySelector(".dashboard-chart-visual")).toHaveClass("positive"));
    expect(screen.queryByRole("tab", { name: "Trend" })).not.toBeInTheDocument();
    expect(screen.queryByText("Základní scénář za 12 měsíců")).not.toBeInTheDocument();
  });

  it("renders strategy, compact Income calculator and VGLA rent cards", async () => {
    const user = userEvent.setup();
    const router = createTestRouter("/");
    await router.load();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const strategyCard = await screen.findByRole("region", { name: "BTC strategie" });
    const transferButton = await within(strategyCard).findByRole("button", { name: "PŘEVÉST" });
    expect(within(strategyCard).getByText("100 %")).toBeInTheDocument();
    const rentCard = screen.getByRole("button", { name: /VGLA renta/ });
    expect(within(rentCard).getByText(/Měsíčně/)).toBeInTheDocument();
    const incomeCard = screen.getByRole("region", { name: "Income plán" });
    const capitalInput = within(incomeCard).getByRole("textbox", { name: "Částka k rozdělení" });
    expect(capitalInput).toHaveValue("21 600");
    expect(within(incomeCard).getByText("Bitcoin")).toBeInTheDocument();
    expect(within(incomeCard).getByText("Dluhy")).toBeInTheDocument();
    expect(within(incomeCard).getByText("Spending účet")).toBeInTheDocument();
    expect(within(incomeCard).getByText(/14[  ]525[  ]Kč/)).toBeInTheDocument();
    expect(within(incomeCard).getByText(/5[  ]000[  ]Kč/)).toBeInTheDocument();
    expect(within(incomeCard).getByText(/2[  ]075[  ]Kč/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /BTC účty/ })).not.toBeInTheDocument();

    await user.click(transferButton);
    await waitFor(() => expect(router.state.location.pathname).toBe("/strategy"));
    expect(router.state.location.search).toMatchObject({ dialog: "execute" });
    expect(await screen.findByRole("dialog", { name: /Převést/ })).toBeInTheDocument();
  });
});
