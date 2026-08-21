import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  createBrowserHistory,
  type RouterHistory,
} from '@tanstack/react-router'
import App from './App'
import { BitcoinPage } from './pages/BitcoinPage'
import { DashboardPage } from './pages/DashboardPage'

const rootRoute = createRootRoute({ component: App })
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
})
const bitcoinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bitcoin',
  component: BitcoinPage,
})
const routeTree = rootRoute.addChildren([dashboardRoute, bitcoinRoute])

export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({ routeTree, history })
}

export function createTestRouter(path = '/') {
  return createAppRouter(createMemoryHistory({ initialEntries: [path] }))
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
