import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
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
    renderApp()
    const logo = screen.getByRole('button', { name: 'FINSTRAT domů' })

    await user.click(logo)
    await user.click(logo)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(logo)
    expect(screen.getByRole('dialog', { name: 'Přihlášení' })).toBeInTheDocument()
  })

  it('does not expose account switching in default mode', () => {
    renderApp()
    expect(screen.queryByText(/přihl/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Odhlásit' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('BTC / USD')).toBeInTheDocument()
    expect(screen.getByText('Strategy bar')).toBeInTheDocument()
    expect(screen.queryByText('PRIVATE LEDGER')).not.toBeInTheDocument()
  })

  it('prefills the remembered username and clears it on first focus', async () => {
    localStorage.setItem('finstrat:last-username', 'samuel')
    const user = userEvent.setup()
    renderApp()
    const logo = screen.getByRole('button', { name: 'FINSTRAT domů' })
    await user.click(logo)
    await user.click(logo)
    await user.click(logo)

    const username = screen.getByLabelText('Uživatelské jméno')
    expect(username).toHaveValue('samuel')
    await user.click(username)
    expect(username).toHaveValue('')
  })

  it('remembers the username only after a successful login', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/antiforgery')) {
        return { ok: true, status: 200, json: async () => ({ token: 'test-token' }) } as Response
      }
      if (url.endsWith('/login')) return { ok: true, status: 204 } as Response
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'default', userName: 'default', displayName: 'Default User', email: null,
          isDefault: true, householdId: 'household', role: 'owner',
        }),
      } as Response
    })
    const user = userEvent.setup()
    renderApp()
    const logo = screen.getByRole('button', { name: 'FINSTRAT domů' })
    await user.click(logo)
    await user.click(logo)
    await user.click(logo)
    await user.type(screen.getByLabelText('Uživatelské jméno'), 'samuel')
    await user.type(screen.getByLabelText('Heslo'), 'Sample324')
    await user.click(screen.getByRole('button', { name: 'Otevřít relaci' }))

    await waitFor(() => expect(localStorage.getItem('finstrat:last-username')).toBe('samuel'))
  })
})
