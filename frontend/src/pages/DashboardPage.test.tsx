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
                checkpointAuto: true,
                checkpointActivationThresholdCzk: 100000,
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
        if (url.endsWith("/vwce/overview"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              totals: {
                shares: 20,
                costBasisCzk: 70000,
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
        if (url.endsWith("/vwce-price"))
          return {
            ok: true,
            status: 200,
            json: async () => ({ priceCzk: 4000, isStale: false }),
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

    expect(
      await screen.findByText("HODNOTA PORTFOLIA BEZ HOTOVOSTI"),
    ).toBeInTheDocument();
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
      name: "Graf vývoje měsíční renty z VWCE",
    });
    vi.spyOn(rentChart.parentElement!, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 1000,
    } as DOMRect);
    fireEvent.pointerMove(rentChart.parentElement!, { clientX: 0 });
    expect(screen.getByText(/Měsíční renta .*Kč/)).toBeInTheDocument();
    expect(screen.getByText(/Hodnota VWCE .*Kč/)).toBeInTheDocument();
    expect(screen.getByText(/při sazbě 2 % p.a./i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1M" }));
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

  it("alerts about due scheduled payments and opens Debts after confirmation", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/debts/overview"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totals: {
              activeBalanceCzk: 10000,
              repayableBalanceCzk: 10000,
              mortgageBalanceCzk: 0,
              activeCount: 1,
              closedCount: 0,
            },
            debts: [
              {
                id: "loan",
                name: "Půjčka",
                priority: 5,
                isMortgage: false,
                openedAt: "2026-01-01",
                closedAt: null,
                note: null,
                balanceCzk: 10000,
                scheduledPaymentCzk: 5000,
                entryCount: 2,
                latestActivityAt: "2026-08-25",
              },
            ],
            recentEntries: [],
            scheduledPayments: [
              {
                id: "due",
                debtId: "loan",
                debtName: "Půjčka",
                type: "scheduled_payment",
                amountCzk: 5000,
                effectiveAt: "2026-08-25",
                isScheduled: true,
                isDue: true,
                note: null,
              },
            ],
          }),
        } as Response;
      if (url.endsWith("/btc-price"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ priceUsd: 75000, change24hPercent: 1 }),
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
    });
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

    expect(
      await screen.findByRole("dialog", { name: "Je čas potvrdit splátky" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "OK, přejít na Dluhy" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/debts"));
    expect(
      await screen.findByRole("heading", { name: "Dluhy" }),
    ).toBeInTheDocument();
  });

  it("renders the legacy net-worth strip and opens the matching wealth tab", async () => {
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

    const widget = await screen.findByRole("button", {
      name: "Otevřít tab Čisté jmění",
    });
    expect(within(widget).getByText("Čisté jmění")).toBeInTheDocument();
    expect(
      await within(widget).findByRole("img", {
        name: "Vývoj čistého jmění za 30 dní",
      }),
    ).toBeInTheDocument();
    await user.click(widget);
    await waitFor(() => expect(router.state.location.pathname).toBe("/wealth"));
    expect(router.state.location.search).toMatchObject({ tab: "net" });
    expect(
      await screen.findByRole("tab", { name: "Čisté jmění" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("renders all four live legacy dashboard cards", async () => {
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

    const incomeCard = await screen.findByRole("button", {
      name: "Otevřít Income plán",
    });
    const cardGrid = incomeCard.parentElement!;
    expect(await within(incomeCard).findByText("70 %")).toBeInTheDocument();
    expect(within(incomeCard).getByText("20 %")).toBeInTheDocument();
    expect(within(incomeCard).getByText("10 %")).toBeInTheDocument();
    expect(
      within(incomeCard).getByText(/Plánované splátky: 5[  ]000[  ]Kč/),
    ).toBeInTheDocument();
    const strategyCard = within(cardGrid).getByRole("button", {
      name: "Otevřít BTC strategii",
    });
    expect(within(strategyCard).getByText("PRODAT")).toBeInTheDocument();
    expect(
      within(strategyCard).getByText(/Přesunout do VWCE:/),
    ).toBeInTheDocument();
    const bitcoinCard = within(cardGrid).getByRole("button", {
      name: "Otevřít BTC účty",
    });
    expect(
      within(bitcoinCard).getByText(/300[  ]000[  ]Kč/),
    ).toBeInTheDocument();
    expect(
      within(bitcoinCard).getByText(/100[  ]000[  ]Kč/),
    ).toBeInTheDocument();
    const vwceCard = within(cardGrid).getByRole("button", {
      name: "Otevřít VWCE portfolio",
    });
    expect(within(vwceCard).getByText(/80[  ]000[  ]Kč/)).toBeInTheDocument();
    expect(within(vwceCard).getByText(/133[  ]Kč/)).toBeInTheDocument();
    expect(
      within(cardGrid).queryByText("Připravujeme"),
    ).not.toBeInTheDocument();
    await user.click(incomeCard);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/income-plan"),
    );
  });
});
