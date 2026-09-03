import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import { createTestRouter } from '../router'

vi.mock('qrcode', () => ({ default: { toString: vi.fn().mockResolvedValue('<svg />') } }))

const paymentSettings = {
  cashAccountIban: 'CZ1208000000001234567899',
  coinmateIban: 'CZ6508000000192000145399',
  coinmateVariableSymbol: '123456',
  coinmateRecipientMessage: 'Coinmate deposit',
}

async function renderPage(path: string) {
  const router = createTestRouter(path)
  await router.load()
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

describe('IncomePlanPage', () => {
  beforeEach(() => {
    vi.mocked(QRCode.toString).mockClear()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({
        settings: { defaultCapitalCzk: 1000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0, ...paymentSettings },
        debts: [{ id: 'small', name: 'Malý dluh', priority: 5, balanceCzk: 100 }, { id: 'large', name: 'Velký dluh', priority: 5, balanceCzk: 1000 }, { id: 'excluded', name: 'Mimo plán', priority: 0, balanceCzk: 900 }],
      }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/settings') && options?.method === 'PUT') return { ok: true, status: 200, json: async () => ({}) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('keeps the default identity read-only and preserves allocation calculations', async () => {
    const user = userEvent.setup()
    await renderPage('/income-plan')
    expect(await screen.findByText('Malý dluh')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Zpracovat příjem' })).not.toBeInTheDocument()
    expect(screen.getByText('Mimo automatický plán')).toBeInTheDocument()
    expect(screen.getAllByText(/400[  ]Kč/).length).toBeGreaterThan(0)
    const capital = screen.getByLabelText('Volný kapitál')
    await user.clear(capital)
    await user.type(capital, '1200')
    await user.tab()
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/income-plan/settings') && options?.method === 'PUT')).toBe(true))
  })

  it('shows scheduled and early payments in the existing debt envelope', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 21600, withoutDebtBtcPercent: 90, withoutDebtCashPercent: 10, withDebtBtcPercent: 70, withDebtDebtPercent: 20, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0, ...paymentSettings }, debts: [{ id: 'loan', name: 'Půjčka', priority: 5, balanceCzk: 50000 }], scheduledDebtPaymentCzk: 5000 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', isDefault: true }) } as Response
    })
    await renderPage('/income-plan')
    const debtRow = (await screen.findByText('Pravidelné splátky')).closest('.income-flow-row') as HTMLElement
    expect(within(debtRow).getByText('Předčasné splátky')).toBeInTheDocument()
    expect(within(debtRow).getAllByText(/5[  ]000[  ]Kč/).length).toBeGreaterThan(0)
  })

  it('waits for Coinmate, buys BTC, and records the calculated purchase in the Coinmate account', async () => {
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 10000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0, ...paymentSettings }, debts: [] }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ watchId: 'watch-1', currency: 'czk', initialBalance: 100, expiresInSeconds: 30 }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch/watch-1') && options?.method === undefined) return { ok: true, status: 200, json: async () => ({ changed: true, currency: 'czk', balance: 8600 }) } as Response
      if (url.endsWith('/income-plan/coinmate-bitcoin-purchase') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, btcBought: 0.00425, status: 'filled', pending: false }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, priceCzk: 2000000, change24hPercent: 1 }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'coinmate-account', name: 'Coinmate', canManage: true }] }) } as Response
      if (url.endsWith('/bitcoin/purchases') && options?.method === 'POST') return { ok: true, status: 201, json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false, householdId: 'household', role: 'owner' }) } as Response
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')

    expect(await screen.findByRole('button', { name: 'Ukončit zpracování' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Zpracovat příjem' })).not.toBeInTheDocument()
    expect(document.querySelector('.process-income-backdrop')).not.toBeInTheDocument()
    const btcRow = screen.getByText('Bitcoin').closest('.income-flow-row') as HTMLElement
    expect(btcRow).toHaveAttribute('data-expanded', 'true')
    expect(within(btcRow).getByText('Vklad na Coinmate')).toBeInTheDocument()
    expect(await within(btcRow).findByRole('img', { name: /Coinmate QR pro vklad 8[  ]500[  ]Kč/ })).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'))
    expect(QRCode.toString).toHaveBeenCalledWith('SPD*1.0*ACC:CZ6508000000192000145399*AM:8500.00*CC:CZK*X-VS:123456*MSG:Coinmate deposit*', expect.any(Object))
    expect(within(btcRow).queryByRole('button', { name: /platební údaje/i })).not.toBeInTheDocument()
    const sent = within(btcRow).getByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    expect(vi.mocked(fetch).mock.calls.some(([url, request]) => String(url).endsWith('/income-plan/coinmate-balance-watch') && request?.method === 'POST')).toBe(true)
    await user.click(sent)
    expect(document.querySelector('.income-debt-workflow')).not.toBeInTheDocument()
    const cashRow = screen.getByText('Cash').closest('.income-flow-row') as HTMLElement
    expect(cashRow).toHaveAttribute('data-expanded', 'true')
    expect(await within(cashRow).findByRole('img', { name: /Cash QR pro převod 1[  ]500[  ]Kč/ })).toBeInTheDocument()
    expect(QRCode.toString).toHaveBeenCalledWith('SPD*1.0*ACC:CZ1208000000001234567899*AM:1500.00*CC:CZK*MSG:Cash rezerva*', expect.any(Object))
    await user.click(within(cashRow).getByRole('button', { name: 'Dokončit' }))
    expect(cashRow).toHaveAttribute('data-expanded', 'false')
    expect(await within(btcRow).findByText('BTC nakoupeno a zapsáno')).toBeInTheDocument()
    const purchaseCall = vi.mocked(fetch).mock.calls.find(([url, request]) => String(url).endsWith('/bitcoin/purchases') && request?.method === 'POST')
    expect(purchaseCall?.[1]?.headers).toMatchObject({ 'Idempotency-Key': expect.any(String), 'X-CSRF-TOKEN': 'csrf' })
    expect(JSON.parse(String(purchaseCall?.[1]?.body))).toMatchObject({ accountId: 'coinmate-account', quantityBtc: '0.00425000', unitPriceCzk: '2000000.00', note: 'Automatický nákup z Income plánu' })
    const closingShell = btcRow.querySelector('.income-btc-processing-shell') as HTMLElement
    expect(closingShell).toHaveClass('closing')
    expect(btcRow).toHaveAttribute('data-expanded', 'true')
    fireEvent.transitionEnd(closingShell, { propertyName: 'height' })
    expect(btcRow).toHaveAttribute('data-expanded', 'true')
    expect(within(btcRow).queryByRole('img', { name: /Coinmate QR/ })).not.toBeInTheDocument()
  })

  it('opens debt processing in parallel, advances one debt at a time, and defers only remaining fresh allocation', async () => {
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 1000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 200, ...paymentSettings }, debts: [{ id: 'small', name: 'První dluh', priority: 5, balanceCzk: 100 }, { id: 'large', name: 'Druhý dluh', priority: 5, balanceCzk: 1000 }] }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ watchId: 'watch-debts', currency: 'czk', initialBalance: 100, expiresInSeconds: 30 }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch/watch-debts') && options?.method === undefined) return { ok: true, status: 200, json: async () => ({ changed: true, currency: 'czk', balance: 500 }) } as Response
      if (url.endsWith('/income-plan/coinmate-bitcoin-purchase') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, btcBought: 0.0002, status: 'filled', pending: false }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceCzk: 2000000 }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'coinmate-account', name: 'Coinmate', canManage: true }] }) } as Response
      if (url.endsWith('/bitcoin/purchases') && options?.method === 'POST') return { ok: true, status: 201, json: async () => ({}) } as Response
      if (url.includes('/payments') || url.endsWith('/deferred-debt-payment/consume') || url.endsWith('/deferred-debt-payment')) return { ok: true, status: 200, json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', isDefault: false, displayName: 'Samuel' }) } as Response
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    const btcRow = (await screen.findByText('Bitcoin')).closest('.income-flow-row') as HTMLElement
    const sent = within(btcRow).getByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    await user.click(sent)

    expect(screen.getByText('První dluh', { selector: '.income-debt-current strong' })).toBeInTheDocument()
    expect(screen.queryByText('Druhý dluh', { selector: '.income-debt-current strong' })).not.toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(document.querySelector('.income-debt-current output')).toHaveTextContent(/100[  ]Kč\s*\/\s*100[  ]Kč/)
    expect(screen.queryByRole('button', { name: 'Následující dluh' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Zpracovat' }))
    expect(await screen.findByText('Druhý dluh', { selector: '.income-debt-current strong' })).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()

    const paymentCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/api/debts/small/payments'))
    expect(paymentCall?.[1]?.headers).toMatchObject({ 'Idempotency-Key': expect.any(String), 'X-CSRF-TOKEN': 'csrf' })
    expect(JSON.parse(String(paymentCall?.[1]?.body))).toMatchObject({ amountCzk: '100.00', effectiveAt: expect.any(String), note: expect.any(String) })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/deferred-debt-payment/consume'))).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Odložit zbývající splátky' }))
    await waitFor(() => expect(document.querySelector('.income-debt-workflow')).not.toBeInTheDocument())
    expect(screen.getByText('Cash').closest('.income-flow-row')).toHaveAttribute('data-expanded', 'true')
    const deferCall = vi.mocked(fetch).mock.calls.find(([url, options]) => String(url).endsWith('/deferred-debt-payment') && options?.method === 'POST')
    expect(JSON.parse(String(deferCall?.[1]?.body))).toEqual({ amountCzk: '300.00', expectedDeferredDebtPaymentCzk: '200.00' })
  })

  it('opens Cash after the final debt is processed without completing BTC', async () => {
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 1000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0, ...paymentSettings }, debts: [{ id: 'loan', name: 'Jediný dluh', priority: 5, balanceCzk: 1000 }] }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ watchId: 'watch-final-debt', currency: 'czk', initialBalance: 100, expiresInSeconds: 30 }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch/watch-final-debt') && options?.method === undefined) return { ok: true, status: 200, json: async () => ({ changed: true, currency: 'czk', balance: 500 }) } as Response
      if (url.endsWith('/income-plan/coinmate-bitcoin-purchase') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, btcBought: 0.0002, status: 'filled', pending: false }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceCzk: 2000000 }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'coinmate-account', name: 'Coinmate', canManage: true }] }) } as Response
      if (url.endsWith('/bitcoin/purchases') && options?.method === 'POST') return { ok: true, status: 201, json: async () => ({}) } as Response
      if (url.endsWith('/api/debts/loan/payments')) return { ok: true, status: 200, json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', isDefault: false, displayName: 'Samuel' }) } as Response
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    const sent = await screen.findByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    await user.click(sent)
    await user.click(await screen.findByRole('button', { name: 'Zpracovat' }))

    const cashRow = screen.getByText('Cash').closest('.income-flow-row') as HTMLElement
    await waitFor(() => expect(cashRow).toHaveAttribute('data-expanded', 'true'))
    await user.click(within(cashRow).getByRole('button', { name: 'Dokončit' }))
    expect(cashRow).toHaveAttribute('data-expanded', 'false')
    expect(await screen.findByText('BTC nakoupeno a zapsáno')).toBeInTheDocument()
  })

  it('keeps debt processing available when the BTC ledger write fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 1000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0, ...paymentSettings }, debts: [{ id: 'loan', name: 'Nezávislý dluh', priority: 5, balanceCzk: 1000 }] }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ watchId: 'watch-error', currency: 'czk', initialBalance: 100, expiresInSeconds: 30 }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch/watch-error') && options?.method === undefined) return { ok: true, status: 200, json: async () => ({ changed: true, currency: 'czk', balance: 500 }) } as Response
      if (url.endsWith('/income-plan/coinmate-bitcoin-purchase') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, btcBought: 0.0002, status: 'filled', pending: false }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceCzk: 2000000 }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [] }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', isDefault: false, displayName: 'Samuel' }) } as Response
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    const sent = await screen.findByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    await user.click(sent)
    expect(await screen.findByText('Nezávislý dluh', { selector: '.income-debt-current strong' })).toBeInTheDocument()
    expect(await screen.findByText('Nákup BTC se nepodařilo dokončit')).toBeInTheDocument()
    expect(screen.getByText('Bitcoin').closest('.income-flow-row')).toHaveAttribute('data-expanded', 'true')
  })

  it('removes processing from the URL through the header action', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 10000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: 0, ...paymentSettings }, debts: [] }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', isDefault: false, displayName: 'Samuel' }) } as Response
    })
    const user = userEvent.setup()
    const router = await renderPage('/income-plan?dialog=process')
    await user.click(await screen.findByRole('button', { name: 'Ukončit zpracování' }))
    await waitFor(() => expect(router.state.location.search.dialog).toBeUndefined())
    expect(screen.getByText('Bitcoin').closest('.income-flow-row')).toHaveAttribute('data-expanded', 'false')
  })
})
