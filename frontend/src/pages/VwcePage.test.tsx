import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('VwcePage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/vwce/overview')) return {
        ok: true,
        status: 200,
        json: async () => ({
          totals: { shares: 0.0139, costBasisCzk: 53.54, accountCount: 1, costBasisComplete: true, provisionalLotCount: 0, rentRatePercent: 2 },
          accounts: [{
            id: 'xtb', name: 'XTB', description: null, ownerDisplayName: 'Samuel', shares: 0.0139,
            costBasisCzk: 53.54, costBasisComplete: true, lotCount: 1, disposalCount: 0,
            provisionalLotCount: 0, latestActivityAt: '2026-05-07T10:00:00Z',
            isOwnedByCurrentUser: true, canManage: true, canShareWithDefault: true, isSharedWithDefault: false,
          }],
          recentMovements: [{
            id: 'lot', accountId: 'xtb', accountName: 'XTB', type: 'purchase', shares: 0.0139,
            unitPriceCzk: 3851.42, proceedsCzk: null, occurredAt: '2026-05-07T10:00:00Z', note: null,
          }],
        }),
      } as Response
      if (url.endsWith('/vwce-price')) return {
        ok: true,
        status: 200,
        json: async () => ({ priceEur: 165.79, priceCzk: 3999, observedAt: '2026-08-21T10:00:00Z', source: 'yahoo-finance', isStale: false }),
      } as Response
      if (url.endsWith('/accounts/xtb/movements')) return { ok: true, status: 200, json: async () => [{
        id: 'account-lot', accountId: 'xtb', accountName: 'XTB', type: 'purchase', shares: 0.0139,
        unitPriceCzk: 3851.42, proceedsCzk: null, occurredAt: '2026-05-07T10:00:00Z', note: 'Nákup na XTB',
        canEdit: true, canDelete: true,
      }] } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf-token' }) } as Response
      if (url.endsWith('/vwce/accounts')) return { ok: true, status: 201, json: async () => ({ id: 'new-account' }) } as Response
      if (url.endsWith('/vwce/payouts')) return { ok: true, status: 201, json: async () => ({ id: 'payout' }) } as Response
      if (url.endsWith('/vwce/accounts/xtb/purchases')) return { ok: true, status: 201, json: async () => ({ id: 'new-purchase' }) } as Response
      if (url.endsWith('/default-share')) return { ok: true, status: 204 } as Response
      if (url.endsWith('/vwce/accounts/xtb')) return init?.method === 'DELETE'
        ? { ok: true, status: 204 } as Response
        : { ok: true, status: 200, json: async () => ({ id: 'xtb', name: 'XTB upraveno' }) } as Response
      if (url.endsWith('/vwce/movements/account-lot/purchase')) return { ok: true, status: 204 } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false, householdId: 'household', role: 'owner', sessionExpiresAt: null }) } as Response
    }))
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('renders owner-scoped VWCE totals, broker and history', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createTestRouter('/vwce')
    await router.load()
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)

    expect(await screen.findByRole('heading', { name: 'VWCE' })).toBeInTheDocument()
    expect((await screen.findAllByText('XTB')).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/0,0139/).length).toBeGreaterThan(0)
    expect(screen.getByText('Hodnota portfolia')).toBeInTheDocument()
    expect(screen.getAllByText('Zisk / ztráta')).toHaveLength(2)
    expect(screen.getByText('Renta 2 % p.a.')).toBeInTheDocument()
    expect(screen.queryByText('Cena VWCE')).not.toBeInTheDocument()
    expect(screen.getAllByText(/56[  ]Kč/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\+2[  ]Kč/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('+3,8 %')).toHaveLength(2)
    const broker = screen.getAllByText('XTB')[0].closest('details') as HTMLElement
    await user.click(screen.getByText('Bez popisu'))
    expect(broker).toHaveAttribute('open')
    expect(screen.getByText(/Investováno/)).toBeVisible()
    expect(screen.getByText('Nákup na XTB')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Přidat nákup' }))
    const purchaseDialog = screen.getByRole('dialog', { name: 'Přidat nákup · XTB' })
    await user.type(within(purchaseDialog).getByLabelText('Počet podílů'), '0.25')
    expect(within(purchaseDialog).getByLabelText('Cena za podíl (Kč)')).toHaveValue('3999.00')
    await user.click(within(purchaseDialog).getByRole('button', { name: 'Přidat nákup' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) => String(input).endsWith('/vwce/accounts/xtb/purchases') && options?.method === 'POST')).toBe(true))
    await user.click(screen.getByRole('button', { name: 'Upravit pohyb' }))
    await user.click(screen.getByRole('button', { name: 'Uložit pohyb' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) => String(input).endsWith('/vwce/movements/account-lot/purchase') && options?.method === 'PUT')).toBe(true))
    await user.click(screen.getByRole('button', { name: 'Odstranit pohyb' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Odstranit nákup' })).getByRole('button', { name: 'Odstranit pohyb' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) => String(input).endsWith('/vwce/movements/account-lot/purchase') && options?.method === 'DELETE')).toBe(true))
    await user.click(screen.getByRole('button', { name: 'Vlastník' }))
    const sharingSwitch = screen.getByRole('switch', { name: 'Sdílet s defaultem' })
    expect(sharingSwitch).toHaveAttribute('aria-checked', 'false')
    await user.click(sharingSwitch)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/default-share'))).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Upravit účet XTB' }))
    const editName = screen.getByLabelText('Název účtu')
    await user.clear(editName)
    await user.type(editName, 'XTB upraveno')
    await user.click(screen.getByRole('button', { name: 'Uložit změny' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) =>
      String(input).endsWith('/vwce/accounts/xtb') && options?.method === 'PUT')).toBe(true))
    await user.click(screen.getByRole('button', { name: 'Odstranit účet XTB' }))
    await user.click(screen.getByRole('button', { name: 'Odstranit účet' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) =>
      String(input).endsWith('/vwce/accounts/xtb') && options?.method === 'DELETE')).toBe(true))
    expect(screen.getAllByText('Nákup').length).toBeGreaterThan(0)
  })

  it('creates a broker account and submits a rent payout from header actions', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createTestRouter('/vwce')
    await router.load()
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)
    await screen.findByText('Celkem akcií')

    await user.click(screen.getByRole('button', { name: 'Nový účet' }))
    expect(screen.getByRole('dialog', { name: 'Nový broker účet' })).toBeVisible()
    await user.type(screen.getByLabelText('Název účtu'), 'Degiro')
    await user.click(screen.getByRole('button', { name: 'Vytvořit účet' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) =>
      String(input).endsWith('/vwce/accounts') && options?.method === 'POST')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Vyplatit' }))
    expect(screen.getByRole('dialog', { name: 'Výplata renty' })).toBeVisible()
    const amount = screen.getByLabelText('Částka k výplatě (Kč)')
    await user.clear(amount)
    await user.type(amount, '10')
    await user.type(screen.getByLabelText(/Poznámka/), 'Měsíční renta')
    await user.click(screen.getByRole('button', { name: 'Potvrdit výplatu' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) => {
      if (!String(input).endsWith('/vwce/payouts') || options?.method !== 'POST') return false
      const headers = options.headers as Record<string, string>
      return headers['X-CSRF-TOKEN'] === 'csrf-token'
        && typeof headers['Idempotency-Key'] === 'string'
        && JSON.parse(String(options.body)).amountCzk === '10'
    })).toBe(true))
  })
})
