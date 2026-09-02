import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('IncomePlanPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({
        settings: { defaultCapitalCzk: 1000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0 },
        debts: [
          { id: 'small', name: 'Malý dluh', priority: 5, balanceCzk: 100 },
          { id: 'large', name: 'Velký dluh', priority: 5, balanceCzk: 1000 },
          { id: 'excluded', name: 'Mimo plán', priority: 0, balanceCzk: 900 },
        ],
      }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/settings')) return { ok: true, status: 200, json: async () => ({ defaultCapitalCzk: 1000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10 }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('redistributes capped payments and saves capital without exposing mode labels or percentage settings', async () => {
    const user = userEvent.setup()
    const router = createTestRouter('/income-plan')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    expect(await screen.findByText('Malý dluh')).toBeInTheDocument()
    expect(screen.queryByText('Režim s dluhy')).not.toBeInTheDocument()
    expect(screen.queryByText('Režim bez dluhů')).not.toBeInTheDocument()
    expect(screen.queryByText('Alokační profily')).not.toBeInTheDocument()
    expect(screen.queryByText('Pravidelné splátky')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Zpracovat příjem' })).not.toBeInTheDocument()
    expect(screen.getByText('Velký dluh')).toBeInTheDocument()
    expect(screen.getByText('Mimo automatický plán')).toBeInTheDocument()
    expect(screen.getAllByText(/100[  ]Kč/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/400[  ]Kč/).length).toBeGreaterThan(0)

    const capital = screen.getByLabelText('Volný kapitál')
    expect(capital).toHaveValue('1 000')
    await user.clear(capital)
    await user.type(capital, '1200')
    expect(capital).toHaveValue('1 200')
    await user.tab()
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/income-plan/settings') && options?.method === 'PUT')).toBe(true))
    const saveCall = vi.mocked(fetch).mock.calls.find(([url, options]) => String(url).endsWith('/income-plan/settings') && options?.method === 'PUT')
    expect(JSON.parse(String(saveCall?.[1]?.body)).defaultCapitalCzk).toBe('1200')
  })

  it('splits the debt row into scheduled and early payments when a future payment exists', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({
        settings: { defaultCapitalCzk: 21600, withoutDebtBtcPercent: 90, withoutDebtCashPercent: 10, withDebtBtcPercent: 70, withDebtDebtPercent: 20, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0 },
        debts: [{ id: 'loan', name: 'Půjčka', priority: 5, balanceCzk: 50000 }],
        scheduledDebtPaymentCzk: 5000,
      }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    })
    const router = createTestRouter('/income-plan')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    const debtRow = (await screen.findByText('Pravidelné splátky')).closest('.income-flow-row') as HTMLElement
    expect(within(debtRow).getByText('Předčasné splátky')).toBeInTheDocument()
    expect(within(debtRow).getAllByText(/5[  ]000[  ]Kč/).length).toBeGreaterThan(0)
    expect(within(debtRow).getByText(/^0[  ]Kč$/)).toBeInTheDocument()
    expect(screen.getByText(/14[  ]525[  ]Kč/)).toBeInTheDocument()
    expect(screen.getByText(/2[  ]075[  ]Kč/)).toBeInTheDocument()
  })

  it('offers the processing workflow only to a signed-in user and records its actions', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({
        settings: { defaultCapitalCzk: 20000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 2000 },
        debts: [{ id: 'loan', name: 'Půjčka', priority: 5, balanceCzk: 50000 }],
      }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'trezor', name: 'Trezor', canManage: true }] }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, priceCzk: 2000000, change24hPercent: 1 }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/bitcoin/purchases') || url.includes('/payments')) return { ok: true, status: 201, json: async () => ({ id: 'created' }) } as Response
      if (url.endsWith('/deferred-debt-payment/consume')) return { ok: true, status: 200, json: async () => ({ deferredDebtPaymentCzk: 0 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false, householdId: 'household', role: 'owner', sessionExpiresAt: new Date(Date.now() + 900000).toISOString() }) } as Response
    })
    const user = userEvent.setup()
    const router = createTestRouter('/income-plan?dialog=process')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    expect(await screen.findByRole('dialog', { name: 'Zpracovat příjem' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zpracovat příjem' })).toBeInTheDocument()
    expect(screen.getByText(/Zbývajících 18[  ]000[  ]Kč se dělí procenty/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Zaplatit vše \(11[  ]000[  ]Kč\)/ })).toBeInTheDocument()
    const cashQr = screen.getByLabelText('QR platba do Cash rezervy')
    expect(await within(cashQr).findByRole('img', { name: /QR platba 1[  ]800[  ]Kč/ })).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'))
    await user.click(screen.getByRole('button', { name: 'Zapsat nákup' }))
    const purchaseDialog = await screen.findByRole('dialog', { name: 'Přidat nákup' })
    await user.click(within(purchaseDialog).getByRole('button', { name: 'Aktuální' }))
    await user.clear(within(purchaseDialog).getByLabelText('Množství BTC'))
    await user.type(within(purchaseDialog).getByLabelText('Množství BTC'), '0,01')
    await user.click(within(purchaseDialog).getByRole('button', { name: 'Přidat nákup' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/bitcoin/purchases') && options?.method === 'POST')).toBe(true))
    const btcPurchase = vi.mocked(fetch).mock.calls.find(([url, options]) => String(url).endsWith('/bitcoin/purchases') && options?.method === 'POST')
    expect(JSON.parse(String((btcPurchase![1] as RequestInit).body))).toMatchObject({ quantityBtc: '0.01', unitPriceCzk: '2000000.00' })
    await user.click(screen.getByRole('button', { name: /Zaplatit vše/ }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).includes('/payments') && options?.method === 'POST')).toBe(true))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/deferred-debt-payment/consume') && options?.method === 'POST')).toBe(true))
    const consumeCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/deferred-debt-payment/consume'))
    expect(JSON.parse(String(consumeCall?.[1]?.body))).toMatchObject({ amountCzk: '2000.00', expectedDeferredDebtPaymentCzk: '2000.00' })
  })

  it('splits a partially covered BTC allocation into direct BTC and deferred VWCE', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({
        settings: { defaultCapitalCzk: 10000, withoutDebtBtcPercent: 60, withoutDebtCashPercent: 40, withDebtBtcPercent: 60, withDebtDebtPercent: 25, withDebtCashPercent: 15, deferredDebtPaymentCzk: 0 },
        debts: [], deferredVwceCzk: 2000,
      }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'trezor', name: 'Trezor', canManage: true }] }) } as Response
      if (url.endsWith('/vwce/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'broker', name: 'Broker', isOwnedByCurrentUser: true }] }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceCzk: 2000000 }) } as Response
      if (url.endsWith('/vwce-price')) return { ok: true, status: 200, json: async () => ({ priceCzk: 4000 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false, householdId: 'household', role: 'owner', sessionExpiresAt: new Date(Date.now() + 900000).toISOString() }) } as Response
    })
    const router = createTestRouter('/income-plan?dialog=process')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    await screen.findAllByText('VWCE místo BTC')
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.income-flow-row'))
    const vwceRow = rows.find((row) => row.textContent?.includes('VWCE místo BTC'))!
    const btcRow = rows.find((row) => row.textContent?.includes('Bitcoin'))!
    expect(within(vwceRow).getByText(/2[  ]000[  ]Kč/, { selector: 'output' })).toBeInTheDocument()
    expect(within(btcRow).getByText(/4[  ]000[  ]Kč/, { selector: 'output' })).toBeInTheDocument()
    expect(within(vwceRow).getByText('20 %')).toBeInTheDocument()
    expect(within(btcRow).getByText('40 %')).toBeInTheDocument()
    expect(screen.getByText(/Kup za 2[  ]000[  ]Kč; potvrzením se o tuto částku sníží pool/)).toBeInTheDocument()
  })

  it('adds the current fresh debt allocation to an existing deferred payment', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 20000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 2000 }, debts: [{ id: 'loan', name: 'Půjčka', priority: 5, balanceCzk: 50000 }] }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [] }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/deferred-debt-payment')) return { ok: true, status: 200, json: async () => ({ deferredDebtPaymentCzk: 11000 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false, householdId: 'household', role: 'owner', sessionExpiresAt: new Date(Date.now() + 900000).toISOString() }) } as Response
    })
    const router = createTestRouter('/income-plan?dialog=process')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    await userEvent.click(await screen.findByRole('button', { name: /Odložit znovu \(11[  ]000[  ]Kč\)/ }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/deferred-debt-payment'))).toBe(true))
    expect(await screen.findByText(/9[  ]000[  ]Kč bylo přičteno/)).toBeInTheDocument()
    const deferCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/deferred-debt-payment'))
    expect(JSON.parse(String(deferCall?.[1]?.body))).toMatchObject({ amountCzk: '9000.00', expectedDeferredDebtPaymentCzk: '2000.00' })
  })

  it('keeps an existing deferred payment deferred when there is no fresh debt allocation', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 50000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 75000 }, debts: [{ id: 'loan', name: 'Půjčka', priority: 5, balanceCzk: 100000 }] }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [] }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false, householdId: 'household', role: 'owner', sessionExpiresAt: new Date(Date.now() + 900000).toISOString() }) } as Response
    })
    const router = createTestRouter('/income-plan?dialog=process')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    await userEvent.click(await screen.findByRole('button', { name: /Odložit znovu \(50[  ]000[  ]Kč\)/ }))
    expect(screen.getByText(/Odložená splátka 75[  ]000[  ]Kč zůstává odložená/)).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/deferred-debt-payment'))).toBe(false)
  })

  it('lets the signed-in user delete the deferred payment balance', async () => {
    let deferred = 2000
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 20000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: deferred }, debts: [{ id: 'loan', name: 'Půjčka', priority: 5, balanceCzk: 50000 }] }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.includes('/deferred-debt-payment?') && options?.method === 'DELETE') { deferred = 0; return { ok: true, status: 204 } as Response }
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false, householdId: 'household', role: 'owner', sessionExpiresAt: new Date(Date.now() + 900000).toISOString() }) } as Response
    })
    const router = createTestRouter('/income-plan')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    await userEvent.click(await screen.findByRole('button', { name: 'Smazat odložené splátky' }))
    await waitFor(() => expect(screen.queryByText('Odložené splátky')).not.toBeInTheDocument())
    const deleteCall = vi.mocked(fetch).mock.calls.find(([url, options]) => String(url).includes('/deferred-debt-payment?') && options?.method === 'DELETE')
    expect(String(deleteCall?.[0])).toContain('expectedDeferredDebtPaymentCzk=2000.00')
  })
})
