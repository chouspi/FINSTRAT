import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('DebtsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/debts/overview')) return { ok: true, status: 200, json: async () => ({
        totals: { activeBalanceCzk: 2600000, repayableBalanceCzk: 100000, mortgageBalanceCzk: 2500000, activeCount: 2, closedCount: 1 },
        debts: [
          { id: 'loan', name: 'Spotřebitelský úvěr', priority: 5, isMortgage: false, openedAt: '2026-01-01', closedAt: null, note: 'Auto', balanceCzk: 100000, entryCount: 2, latestActivityAt: '2026-08-21' },
          { id: 'mortgage', name: 'Hypotéka', priority: 3, isMortgage: true, openedAt: '2025-01-01', closedAt: null, note: null, balanceCzk: 2500000, entryCount: 1, latestActivityAt: '2025-01-01' },
          { id: 'paid', name: 'Stará půjčka', priority: 3, isMortgage: false, openedAt: '2024-01-01', closedAt: '2026-06-01', note: null, balanceCzk: 0, entryCount: 2, latestActivityAt: '2026-06-01' },
        ],
        recentEntries: [{ id: 'payment', debtId: 'loan', debtName: 'Spotřebitelský úvěr', type: 'payment', amountCzk: 5000, effectiveAt: '2026-08-21', note: 'Srpen' }],
      }) } as Response
      if (url.includes('/entries')) return { ok: true, status: 200, json: async () => [{ id: 'opening', debtId: 'loan', debtName: 'Spotřebitelský úvěr', type: 'opening_balance', amountCzk: 105000, effectiveAt: '2026-01-01', note: null }] } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/api/debts') || url.includes('/payments') || url.includes('/drawdowns') || url.endsWith('/archive')) return { ok: true, status: url.endsWith('/api/debts') || url.includes('/drawdowns') ? 201 : 204, json: async () => ({ id: 'new' }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('renders debt metrics, expandable ledger, creation and payment workflows', async () => {
    const user = userEvent.setup()
    const router = createTestRouter('/debts')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)
    expect(await screen.findByRole('heading', { name: 'Dluhy' })).toBeInTheDocument()
    expect(await screen.findByText('Spotřebitelský úvěr')).toBeInTheDocument()
    expect(screen.getAllByText('Hypotéka').length).toBeGreaterThan(0)
    expect(screen.getByText('Stará půjčka')).toBeInTheDocument()
    const loanRow = screen.getByText('Spotřebitelský úvěr').closest('details') as HTMLElement
    await user.click(screen.getByText(/Auto/))
    expect(await within(loanRow).findByText('Počáteční zůstatek')).toBeVisible()

    await user.click(within(loanRow).getByRole('button', { name: 'Navýšit' }))
    const drawdown = screen.getByRole('dialog', { name: 'Navýšit půjčku' })
    await user.type(within(drawdown).getByLabelText('Částka navýšení (Kč)'), '25000')
    expect(within(drawdown).getByText(/125[  ]000[  ]Kč/)).toBeInTheDocument()
    await user.click(within(drawdown).getByRole('button', { name: 'Navýšit půjčku' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/api/debts/loan/drawdowns') && options?.method === 'POST')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Smazat splátku Spotřebitelský úvěr' }))
    await user.click(screen.getByRole('button', { name: 'Potvrdit smazání splátky Spotřebitelský úvěr' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).includes('/payments/payment') && options?.method === 'DELETE')).toBe(true))

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Správa dluhů' }))
    const management = screen.getByRole('dialog', { name: 'Správa dluhů' })
    await user.click(within(management).getByRole('button', { name: 'Nastavit prioritu 3 pro Spotřebitelský úvěr' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/api/debts/loan') && options?.method === 'PUT')).toBe(true))
    const priorityCall = vi.mocked(fetch).mock.calls.find(([url, options]) => String(url).endsWith('/api/debts/loan') && options?.method === 'PUT')
    expect(JSON.parse(String(priorityCall?.[1]?.body))).toMatchObject({ name: 'Spotřebitelský úvěr', priority: 3, isMortgage: false, note: 'Auto' })
    expect(within(management).getByText('Mimo Income plán')).toBeInTheDocument()
    await user.click(within(management).getByRole('button', { name: 'Upravit Spotřebitelský úvěr' }))
    expect(await screen.findByRole('dialog', { name: 'Upravit dluh' })).toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog', { name: 'Upravit dluh' })).getByRole('button', { name: 'Zrušit' }))

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Přidat dluh' }))
    await user.type(screen.getByLabelText('Název'), 'Nová půjčka')
    await user.type(screen.getByLabelText('Počáteční zůstatek (Kč)'), '25000')
    await user.click(within(screen.getByRole('dialog', { name: 'Přidat dluh' })).getByRole('button', { name: 'Přidat dluh' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/api/debts') && options?.method === 'POST')).toBe(true))

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Zapsat splátku' }))
    await user.type(screen.getByLabelText('Částka splátky (Kč)'), '10000')
    expect(screen.getByLabelText('Částka splátky (Kč)')).toHaveValue('10000')
    expect(screen.getByText('Po splátce').closest('span')).toHaveTextContent(/90[  ]000[  ]Kč/)
    await user.click(screen.getByRole('button', { name: 'Potvrdit splátku' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).includes('/payments') && options?.method === 'POST')).toBe(true))

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Zapsat splátku' }))
    const scheduledDialog = screen.getByRole('dialog', { name: 'Zapsat splátku' })
    await user.click(within(scheduledDialog).getByRole('button', { name: 'Celá částka' }))
    await user.clear(within(scheduledDialog).getByLabelText('Datum splátky'))
    await user.type(within(scheduledDialog).getByLabelText('Datum splátky'), '31.12.2099')
    expect(await screen.findByRole('dialog', { name: 'Naplánovat splátku' })).toBeInTheDocument()
    expect(screen.getByText('Dluh bude plně pokrytý')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Naplánovat splátku' }))
    const scheduledCall = vi.mocked(fetch).mock.calls.filter(([url, options]) => String(url).endsWith('/debts/loan/payments') && options?.method === 'POST').at(-1)
    expect(JSON.parse(String(scheduledCall?.[1]?.body))).toMatchObject({ amountCzk: '100000.00', effectiveAt: '2099-12-31' })
  })

  it('confirms due payments and offers the next monthly payment across a year boundary', async () => {
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/debts/overview')) return { ok: true, status: 200, json: async () => ({
        totals: { activeBalanceCzk: 10000, repayableBalanceCzk: 10000, mortgageBalanceCzk: 0, activeCount: 1, closedCount: 0 },
        debts: [{ id: 'loan', name: 'Půjčka', priority: 5, isMortgage: false, openedAt: '2026-01-01', closedAt: null, note: null, balanceCzk: 10000, scheduledPaymentCzk: 5000, entryCount: 2, latestActivityAt: '2026-12-15' }],
        recentEntries: [],
        scheduledPayments: [{ id: 'scheduled', debtId: 'loan', debtName: 'Půjčka', type: 'scheduled_payment', amountCzk: 5000, effectiveAt: '2026-12-15', isScheduled: true, isDue: true, note: 'Měsíční splátka' }],
      }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/scheduled-payments/scheduled/confirm')) return { ok: true, status: 200, json: async () => ({ confirmedCount: 1, confirmedAmountCzk: 5000, payments: [{ debtId: 'loan', debtName: 'Půjčka', amountCzk: 5000, effectiveAt: '2026-12-15', nextEffectiveAt: '2027-01-15', note: 'Měsíční splátka' }] }) } as Response
      if (url.endsWith('/debts/loan/payments/scheduled') && options?.method === 'DELETE') return { ok: true, status: 204 } as Response
      if (url.endsWith('/debts/loan/payments') && options?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'next' }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    })
    const user = userEvent.setup()
    const router = createTestRouter('/debts')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    expect(await screen.findByText('PLÁNOVANÉ SPLÁTKY')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Smazat plánovanou splátku Půjčka' }))
    const deletion = screen.getByRole('dialog', { name: 'Smazat plánovanou splátku?' })
    await user.click(within(deletion).getByRole('button', { name: 'Smazat plánovanou splátku' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, request]) => String(url).endsWith('/debts/loan/payments/scheduled') && request?.method === 'DELETE')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Splatit' }))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/scheduled-payments/scheduled/confirm'))).toBe(false)
    const confirmation = screen.getByRole('dialog', { name: 'Potvrdit plánovanou splátku?' })
    await user.click(within(confirmation).getByRole('button', { name: 'Ano, splatit' }))
    const renewal = await screen.findByRole('dialog', { name: 'Naplánovat další splátku?' })
    expect(within(renewal).getByText(/Aktuální splátka už byla potvrzena/)).toBeInTheDocument()
    expect(within(renewal).getByText(/15\. 1\. 2027/)).toBeInTheDocument()
    await user.click(within(renewal).getByRole('button', { name: 'Neplánovat další' }))

    expect(vi.mocked(fetch).mock.calls.some(([url, request]) => String(url).endsWith('/debts/loan/payments') && request?.method === 'POST')).toBe(false)
  })
})
