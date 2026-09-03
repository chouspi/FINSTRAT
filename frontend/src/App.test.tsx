import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from './router'

async function renderApp(path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createTestRouter(path)
  await router.load()
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('hidden login', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps login hidden until the third BTC logo click', async () => {
    const user = userEvent.setup()
    await renderApp()
    const logo = screen.getByRole('button', { name: 'FINSTRAT domů' })

    await user.click(logo)
    await user.click(logo)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(logo)
    expect(screen.getByRole('dialog', { name: 'Přihlášení' })).toBeInTheDocument()
  })

  it('uses the standalone mobile BTC logo for the same hidden login sequence', async () => {
    const user = userEvent.setup()
    renderApp()
    const logo = await screen.findByRole('button', { name: 'Otevřít přihlášení' })
    await user.click(logo)
    await user.click(logo)
    expect(screen.queryByRole('dialog', { name: 'Přihlášení' })).not.toBeInTheDocument()
    await user.click(logo)
    expect(screen.getByRole('dialog', { name: 'Přihlášení' })).toBeInTheDocument()
  })

  it('does not expose account switching in default mode', async () => {
    await renderApp()
    expect(screen.queryByText(/přihl/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Odhlásit' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    const sidebar = screen.getByRole('complementary')
    expect(within(sidebar).getByText('BTC / USD')).toBeInTheDocument()
    expect(within(sidebar).getByText('Aktivace')).toBeInTheDocument()
    expect(within(screen.getByRole('banner')).queryByText('BTC / USD')).not.toBeInTheDocument()
    expect(screen.queryByText('PRIVATE LEDGER')).not.toBeInTheDocument()
    expect(within(sidebar).queryByText('Výdaje')).not.toBeInTheDocument()
    expect(within(sidebar).queryByText('Dashboard')).not.toBeInTheDocument()
  })

  it('returns to Dashboard when the active navigation item is clicked again', async () => {
    const user = userEvent.setup()
    await renderApp('/income-plan')
    const sidebar = screen.getByRole('complementary')
    const activeLink = within(sidebar).getByRole('link', { name: 'Income plán, zpět na Dashboard' })

    expect(activeLink).toHaveClass('nav-item--active')
    await user.click(activeLink)

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: 'Income plán' })).not.toHaveClass('nav-item--active')
  })

  it('locks page scrolling and closes the legacy mobile sheet with Escape', async () => {
    await renderApp()
    const moreButton = screen.getByRole('button', { name: 'Více' })

    fireEvent.click(moreButton)
    expect(moreButton).toHaveAttribute('aria-expanded', 'true')
    expect(document.body).toHaveClass('bottom-nav-open')
    expect(screen.getByRole('region', { name: 'Další navigace' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(moreButton).toHaveAttribute('aria-expanded', 'false')
    expect(document.body).not.toHaveClass('bottom-nav-open')
    expect(screen.queryByRole('region', { name: 'Další navigace' })).not.toBeInTheDocument()
  })

  it('prefills the remembered username and clears it on first focus', async () => {
    localStorage.setItem('finstrat:last-username', 'samuel')
    const user = userEvent.setup()
    await renderApp()
    const logo = screen.getByRole('button', { name: 'FINSTRAT domů' })
    await user.click(logo)
    await user.click(logo)
    await user.click(logo)

    const username = screen.getByLabelText('Uživatelské jméno')
    expect(username).toHaveValue('samuel')
    await user.click(username)
    expect(username).toHaveValue('')
  })

  it('renders the current BTC/USD price in the sidebar', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/btc-price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            priceUsd: 123456.78,
            priceCzk: 2789000,
            change24hPercent: 2.3456,
            observedAt: new Date().toISOString(),
            source: 'coinbase',
            isStale: false,
          }),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'default', userName: 'default', displayName: 'Default User', email: null,
          isDefault: true, householdId: 'household', role: 'owner', sessionExpiresAt: null,
        }),
      } as Response
    })

    await renderApp()
    expect(await screen.findByText('$123,457')).toBeInTheDocument()
    expect(screen.getByText(/2.789.000.Kč/)).toBeInTheDocument()
  })

  it('remembers the username only after a successful login', async () => {
    const fetchMock = vi.mocked(fetch)
    let loggedIn = false
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/antiforgery')) {
        return { ok: true, status: 200, json: async () => ({ token: 'test-token' }) } as Response
      }
      if (url.endsWith('/login')) {
        loggedIn = true
        return { ok: true, status: 204 } as Response
      }
      if (url.endsWith('/renew')) {
        return { ok: true, status: 204 } as Response
      }
      if (url.endsWith('/bitcoin/overview')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totals: {
              quantityBtc: loggedIn ? 0.125 : 0,
              costBasisCzk: loggedIn ? 120000 : 0,
              accountCount: loggedIn ? 1 : 0,
              costBasisComplete: true,
            },
            accounts: loggedIn ? [{
              id: 'private-account', name: 'Private Trezor', description: null, ownerDisplayName: 'Samuel',
              quantityBtc: 0.125, costBasisCzk: 120000, costBasisComplete: true,
              lotCount: 1, disposalCount: 0, proofCount: 0, latestActivityAt: null,
            }] : [],
            recentMovements: [],
          }),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => loggedIn
          ? {
              id: 'samuel', userName: 'samuel', displayName: 'Samuel', email: null,
              isDefault: false, householdId: 'household', role: 'owner',
              sessionExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            }
          : {
              id: 'default', userName: 'default', displayName: 'Default User', email: null,
              isDefault: true, householdId: 'household', role: 'owner',
            },
      } as Response
    })
    const user = userEvent.setup()
    await renderApp('/bitcoin')
    expect(await screen.findByRole('heading', { name: 'Žádné bitcoinové účty' })).toBeInTheDocument()
    const logo = screen.getByRole('button', { name: 'FINSTRAT domů' })
    await user.click(logo)
    await user.click(logo)
    await user.click(logo)
    await user.type(screen.getByLabelText('Uživatelské jméno'), 'samuel')
    await user.type(screen.getByLabelText('Heslo'), 'Sample324')
    await user.click(screen.getByRole('button', { name: 'Otevřít relaci' }))

    await waitFor(() => expect(localStorage.getItem('finstrat:last-username')).toBe('samuel'))
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Samuel')).toBeInTheDocument())
    expect(await screen.findByText('Private Trezor')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Prodloužit relaci o 15 minut' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/identity/renew', expect.objectContaining({ method: 'POST' })))
    expect(within(screen.getByRole('banner')).getByText(/Končí za \d+ min/)).toBeInTheDocument()
    expect(within(screen.getByRole('complementary')).queryByText('Samuel')).not.toBeInTheDocument()
  })
})
