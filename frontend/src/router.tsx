import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  createBrowserHistory,
  type RouterHistory,
} from "@tanstack/react-router";
import App from "./App";
import { BitcoinPage } from "./pages/BitcoinPage";
import { DashboardPage } from "./pages/DashboardPage";
import { VwcePage } from "./pages/VwcePage";
import { DebtsPage } from "./pages/DebtsPage";
import { IncomePlanPage } from "./pages/IncomePlanPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StrategyPage } from "./pages/StrategyPage";
import { TaxesPage } from "./pages/TaxesPage";
import { WealthPage } from "./pages/WealthPage";

const rootRoute = createRootRoute({ component: App });
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});
const wealthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/wealth",
  component: WealthPage,
  validateSearch: (search: Record<string, unknown>) => ({
    tab:
      search.tab === "net"
        ? ("net" as const)
        : search.tab === "rent"
          ? ("rent" as const)
          : search.tab === "trend"
            ? ("trend" as const)
            : undefined,
  }),
});
const bitcoinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bitcoin",
  component: BitcoinPage,
  validateSearch: (search: Record<string, unknown>) => ({
    dialog:
      search.dialog === "account" || search.dialog === "transfer"
        ? search.dialog
        : undefined,
  }),
});
const incomePlanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/income-plan",
  component: IncomePlanPage,
  validateSearch: (search: Record<string, unknown>) => ({
    dialog: search.dialog === "process" ? search.dialog : undefined,
  }),
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === "strategy" ? ("strategy" as const) : undefined,
  }),
});
const strategyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/strategy",
  component: StrategyPage,
});
const taxesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/taxes",
  component: TaxesPage,
});
const vwceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vwce",
  component: VwcePage,
  validateSearch: (search: Record<string, unknown>) => ({
    dialog:
      search.dialog === "account" || search.dialog === "payout"
        ? search.dialog
        : undefined,
  }),
});
const debtsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debts",
  component: DebtsPage,
  validateSearch: (search: Record<string, unknown>) => ({
    dialog:
      search.dialog === "debt" ||
      search.dialog === "payment" ||
      search.dialog === "manage"
        ? search.dialog
        : undefined,
  }),
});
const routeTree = rootRoute.addChildren([
  dashboardRoute,
  wealthRoute,
  strategyRoute,
  taxesRoute,
  incomePlanRoute,
  settingsRoute,
  bitcoinRoute,
  vwceRoute,
  debtsRoute,
]);

export function createAppRouter(
  history: RouterHistory = createBrowserHistory(),
) {
  return createRouter({ routeTree, history });
}

export function createTestRouter(path = "/") {
  return createAppRouter(createMemoryHistory({ initialEntries: [path] }));
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
