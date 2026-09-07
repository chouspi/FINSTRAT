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
    sessionStorage.clear();
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

  it('recalculates spending before sending and locks the whole plan after sending', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/identity/me')) return { ok: true, status: 200, json: async () => ({ id: 'samuel', userName: 'samuel', displayName: 'Samuel', isDefault: false }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch')) return { ok: true, status: 200, json: async () => ({ watchId: 'lock-watch' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch/lock-watch')) return { ok: true, status: 200, json: async () => ({ changed: false }) } as Response
      return originalFetch(input, options)
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    const capital = await screen.findByLabelText('Volný kapitál')
    const spending = screen.getByText('Spending účet').closest('article') as HTMLElement
    await user.clear(capital)
    await user.type(capital, '190')
    expect(within(spending).getByText(/19[  ]Kč/)).toBeInTheDocument()
    await user.clear(capital)
    await user.type(capital, '1000')
    expect(within(spending).getByText(/100[  ]Kč/)).toBeInTheDocument()
    const sent = screen.getByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    await user.click(sent)
    expect(capital).toHaveAttribute('readonly')
    fireEvent.change(capital, { target: { value: '2000' } })
    expect(capital).toHaveValue('1 000')
    expect(within(spending).getByText(/100[  ]Kč/)).toBeInTheDocument()
  })

  function mockWorkflow(btc: number, cash: number, pool = 0, debts: { id: string; name: string; priority: number; balanceCzk: number }[] = []) {
    let owner = 'samuel'
    let currentCapital = 1000
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: currentCapital, withoutDebtBtcPercent: btc, withoutDebtCashPercent: cash, withDebtBtcPercent: btc, withDebtDebtPercent: 100 - btc - cash, withDebtCashPercent: cash, deferredDebtPaymentCzk: 0, ...paymentSettings }, debts, deferredVwceCzk: pool }) } as Response
      if (url.endsWith('/identity/me')) return { ok: true, status: 200, json: async () => ({ id: owner, displayName: owner, isDefault: false }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch')) return { ok: true, status: 200, json: async () => ({ watchId: 'resume-watch' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch/resume-watch')) return { ok: true, status: 200, json: async () => ({ changed: true, balance: 1000 }) } as Response
      if (url.endsWith('/income-plan/coinmate-bitcoin-purchase')) return { ok: true, status: 200, json: async () => ({ success: true, btcBought: .001, pending: false, status: 'filled' }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'coinmate', name: 'Coinmate', canManage: true }] }) } as Response
      return { ok: true, status: options?.method === 'POST' ? 201 : 200, json: async () => ({}) } as Response
    })
    return { owner: (value: string) => { owner = value }, capital: (value: number) => { currentCapital = value } }
  }

  it('skips zero BTC and opens Spending without starting Coinmate', async () => {
    mockWorkflow(0, 100)
    await renderPage('/income-plan?dialog=process')
    expect(await screen.findByRole('img', { name: /Spending QR pro převod 1[  ]000/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Odesláno' })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('coinmate-balance-watch'))).toBe(false)
  })

  it('processes a full VWCE allocation without BTC or Spending and restores its summary', async () => {
    mockWorkflow(100, 0, 2000)
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    await user.click(await screen.findByRole('button', { name: 'Částka vyčleněna' }))
    expect(await screen.findByRole('region', { name: 'Souhrn příjmu' })).toHaveTextContent('Vyčleněno na VWCE')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    cleanup()
    await renderPage('/income-plan?dialog=process')
    expect(await screen.findByRole('region', { name: 'Souhrn příjmu' })).toHaveTextContent('1 000')
    expect(screen.queryByRole('button', { name: 'Částka vyčleněna' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Nový příjem' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Souhrn příjmu' })).not.toBeInTheDocument())
  })

  it('handles a partial VWCE allocation before BTC and skips zero Spending', async () => {
    mockWorkflow(100, 0, 250)
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    await user.click(await screen.findByRole('button', { name: 'Částka vyčleněna' }))
    expect(await screen.findByRole('img', { name: /Coinmate QR pro vklad 750/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Odesláno' }))
    expect(await screen.findByText('BTC nakoupeno a zapsáno')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Souhrn příjmu' })).toHaveTextContent('750')
    expect(screen.queryByRole('button', { name: 'Potvrdit odeslání' })).not.toBeInTheDocument()
    const purchases = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/income-plan/coinmate-bitcoin-purchase'))
    expect(purchases()).toHaveLength(1)
    cleanup()
    await renderPage('/income-plan?dialog=process')
    expect(await screen.findByText('BTC nakoupeno a zapsáno')).toBeInTheDocument()
    expect(purchases()).toHaveLength(1)
  })

  it('restores original amounts and completed debt steps without exposing another users draft', async () => {
    const control = mockWorkflow(0, 20, 0, [{ id: 'a', name: 'První dluh', priority: 5, balanceCzk: 10000 }, { id: 'b', name: 'Druhý dluh', priority: 5, balanceCzk: 10000 }])
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    await user.click(await screen.findByRole('button', { name: 'Zapsat uhrazenou splátku' }))
    expect(await screen.findByText('Druhý dluh', { selector: '.income-debt-current > strong' })).toBeInTheDocument()
    control.capital(5000)
    cleanup()
    await renderPage('/income-plan?dialog=process')
    expect(await screen.findByLabelText('Volný kapitál')).toHaveValue('1 000')
    expect(screen.getByText('Druhý dluh', { selector: '.income-debt-current > strong' })).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/debts/a/payments'))).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Zapsat uhrazenou splátku' }))
    await user.click(await screen.findByRole('button', { name: 'Potvrdit odeslání' }))
    cleanup()
    await renderPage('/income-plan?dialog=process')
    expect(await screen.findByRole('region', { name: 'Souhrn příjmu' })).toHaveTextContent('Zapsané splátky')
    expect(screen.queryByRole('button', { name: 'Potvrdit odeslání' })).not.toBeInTheDocument()
    control.owner('other-user')
    cleanup()
    await renderPage('/income-plan?dialog=process')
    expect(await screen.findByLabelText('Volný kapitál')).toHaveValue('5 000')
    expect(screen.queryByRole('region', { name: 'Souhrn příjmu' })).not.toBeInTheDocument()
  })

  it('reuses the purchase idempotency key and timestamp when recovering an interrupted BTC ledger write', async () => {
    mockWorkflow(100, 0)
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    const sent = await screen.findByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    await user.click(sent)
    await screen.findByText('BTC nakoupeno a zapsáno')
    const ledger = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/bitcoin/purchases'))
    const original = ledger()[0][1]!
    cleanup()
    const key = 'finstrat:income-draft::samuel'
    const saved = JSON.parse(sessionStorage.getItem(key)!)
    sessionStorage.setItem(key, JSON.stringify({ ...saved, purchaseResult: null }))
    await renderPage('/income-plan?dialog=process')
    await screen.findByText('BTC nakoupeno a zapsáno')
    expect(ledger()).toHaveLength(2)
    expect(ledger()[1][1]?.headers).toEqual(original.headers)
    expect(ledger()[1][1]?.body).toEqual(original.body)
  })

  it('resumes the existing deposit watch after refresh instead of resetting its baseline', async () => {
    mockWorkflow(100, 0)
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let refreshed = false
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      if (!refreshed && String(input).endsWith('/income-plan/coinmate-balance-watch/resume-watch')) return new Promise<Response>(() => {})
      return originalFetch(input, options)
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    const sent = await screen.findByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    await user.click(sent)
    expect(await screen.findByText('Čekám na připsání CZK')).toBeInTheDocument()
    cleanup()
    refreshed = true
    await renderPage('/income-plan?dialog=process')
    expect(await screen.findByText('BTC nakoupeno a zapsáno')).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/income-plan/coinmate-balance-watch'))).toHaveLength(1)
  })

  it('retries an interrupted debt write with the original request identity after refresh', async () => {
    mockWorkflow(0, 0, 0, [{ id: 'loan', name: 'Úvěr', priority: 5, balanceCzk: 2000 }])
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let interrupted = true
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      if (String(input).endsWith('/debts/loan/payments') && interrupted) throw new Error('Spojení přerušeno')
      return originalFetch(input, options)
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    await user.click(await screen.findByRole('button', { name: 'Zapsat uhrazenou splátku' }))
    await screen.findByText('Spojení přerušeno')
    cleanup()
    interrupted = false
    await renderPage('/income-plan?dialog=process')
    await user.click(await screen.findByRole('button', { name: 'Zapsat uhrazenou splátku' }))
    expect(await screen.findByRole('region', { name: 'Souhrn příjmu' })).toHaveTextContent('Zapsané splátky')
    const requests = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/debts/loan/payments'))
    expect(requests).toHaveLength(2)
    expect(requests[1][1]).toEqual(requests[0][1])
  })

  it('does not generate payment actions for an empty income', async () => {
    const control = mockWorkflow(0, 100)
    control.capital(0)
    await renderPage('/income-plan?dialog=process')
    await screen.findByLabelText('Volný kapitál')
    expect(screen.queryByRole('button', { name: 'Odesláno' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Potvrdit odeslání' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Souhrn příjmu' })).not.toBeInTheDocument()
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
    const btcRow = screen.getByText('Bitcoin', { selector: '.income-envelope-copy > strong' }).closest('.income-flow-row') as HTMLElement
    expect(btcRow).toHaveAttribute('data-expanded', 'true')
    expect(within(btcRow).getByText('Vklad na Coinmate')).toBeInTheDocument()
    expect(await within(btcRow).findByRole('img', { name: /Coinmate QR pro vklad 8[  ]500[  ]Kč/ })).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'))
    expect(QRCode.toString).toHaveBeenCalledWith('SPD*1.0*ACC:CZ6508000000192000145399*AM:8500.00*CC:CZK*X-VS:123456*MSG:Coinmate deposit*', expect.any(Object))
    expect(within(btcRow).queryByRole('button', { name: /platební údaje/i })).not.toBeInTheDocument()
    const sent = within(btcRow).getByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    expect(vi.mocked(fetch).mock.calls.some(([url, request]) => String(url).endsWith('/income-plan/coinmate-balance-watch') && request?.method === 'POST')).toBe(true)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, request]) => String(url).endsWith('/income-plan/coinmate-balance-watch/watch-1') && request?.method === undefined)).toBe(true))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/income-plan/coinmate-bitcoin-purchase'))).toBe(false)
    await user.click(sent)
    expect(document.querySelector('.income-debt-workflow')).not.toBeInTheDocument()
    const cashRow = screen.getByText('Spending účet').closest('.income-flow-row') as HTMLElement
    expect(cashRow).toHaveAttribute('data-expanded', 'true')
    expect(await within(cashRow).findByRole('img', { name: /Spending QR pro převod 1[  ]500[  ]Kč/ })).toBeInTheDocument()
    expect(QRCode.toString).toHaveBeenCalledWith('SPD*1.0*ACC:CZ1208000000001234567899*AM:1500.00*CC:CZK*MSG:Spending ucet*', expect.any(Object))
    await user.click(within(cashRow).getByRole('button', { name: 'Potvrdit odeslání' }))
    expect(cashRow).toHaveAttribute('data-expanded', 'false')
    expect(within(screen.getByRole('list', { name: 'Průběh zpracování příjmu' })).getByText('Odeslání potvrzeno')).toBeInTheDocument()
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
    let deferredUpdated = false
    let overviewRefetchedAfterDefer = false
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/income-plan/overview')) {
        if (deferredUpdated) overviewRefetchedAfterDefer = true
        return { ok: true, status: 200, json: async () => ({ settings: { defaultCapitalCzk: 1000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 40, withDebtDebtPercent: 50, withDebtCashPercent: 10, deferredDebtPaymentCzk: deferredUpdated ? 500 : 200, ...paymentSettings }, debts: [{ id: 'small', name: 'První dluh', priority: 5, balanceCzk: 100 }, { id: 'large', name: 'Druhý dluh', priority: 5, balanceCzk: 1000 }] }) } as Response
      }
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ watchId: 'watch-debts', currency: 'czk', initialBalance: 100, expiresInSeconds: 30 }) } as Response
      if (url.endsWith('/income-plan/coinmate-balance-watch/watch-debts') && options?.method === undefined) return { ok: true, status: 200, json: async () => ({ changed: true, currency: 'czk', balance: 500 }) } as Response
      if (url.endsWith('/income-plan/coinmate-bitcoin-purchase') && options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, btcBought: 0.0002, status: 'filled', pending: false }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceCzk: 2000000 }) } as Response
      if (url.endsWith('/bitcoin/overview')) return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'coinmate-account', name: 'Coinmate', canManage: true }] }) } as Response
      if (url.endsWith('/bitcoin/purchases') && options?.method === 'POST') return { ok: true, status: 201, json: async () => ({}) } as Response
      if (url.endsWith('/deferred-debt-payment') && options?.method === 'POST') {
        deferredUpdated = true
        return { ok: true, status: 200, json: async () => ({}) } as Response
      }
      if (url.includes('/payments') || url.endsWith('/deferred-debt-payment/consume')) return { ok: true, status: 200, json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'samuel', isDefault: false, displayName: 'Samuel' }) } as Response
    })
    const user = userEvent.setup()
    await renderPage('/income-plan?dialog=process')
    const btcRow = (await screen.findByText('Bitcoin', { selector: '.income-envelope-copy > strong' })).closest('.income-flow-row') as HTMLElement
    const sent = within(btcRow).getByRole('button', { name: 'Odesláno' })
    await waitFor(() => expect(sent).toBeEnabled())
    await user.click(sent)

    expect(screen.getByText('První dluh', { selector: '.income-debt-current strong' })).toBeInTheDocument()
    expect(screen.queryByText('Druhý dluh', { selector: '.income-debt-current strong' })).not.toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(document.querySelector('.income-debt-current output')).toHaveTextContent(/100[  ]Kč\s*\/\s*100[  ]Kč/)
    expect(screen.queryByRole('button', { name: 'Následující dluh' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Zapsat uhrazenou splátku' }))
    expect(await screen.findByText('Druhý dluh', { selector: '.income-debt-current strong' })).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()

    const paymentCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/api/debts/small/payments'))
    expect(paymentCall?.[1]?.headers).toMatchObject({ 'Idempotency-Key': expect.any(String), 'X-CSRF-TOKEN': 'csrf' })
    expect(JSON.parse(String(paymentCall?.[1]?.body))).toMatchObject({ amountCzk: '100.00', effectiveAt: expect.any(String), note: expect.any(String) })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/deferred-debt-payment/consume'))).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Odložit zbývající splátky' }))
    await waitFor(() => expect(document.querySelector('.income-debt-workflow')).not.toBeInTheDocument())
    const cashRow = screen.getByText('Spending účet').closest('.income-flow-row') as HTMLElement
    expect(cashRow).toHaveAttribute('data-expanded', 'true')
    expect(await within(cashRow).findByRole('img', { name: /Spending QR pro převod 80[  ]Kč/ })).toBeInTheDocument()
    expect(overviewRefetchedAfterDefer).toBe(false)
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
    await user.click(await screen.findByRole('button', { name: 'Zapsat uhrazenou splátku' }))

    const cashRow = screen.getByText('Spending účet').closest('.income-flow-row') as HTMLElement
    await waitFor(() => expect(cashRow).toHaveAttribute('data-expanded', 'true'))
    await user.click(within(cashRow).getByRole('button', { name: 'Potvrdit odeslání' }))
    expect(cashRow).toHaveAttribute('data-expanded', 'false')
    expect(within(screen.getByRole('list', { name: 'Průběh zpracování příjmu' })).getByText('Odeslání potvrzeno')).toBeInTheDocument()
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
    expect(screen.getByText('Bitcoin', { selector: '.income-envelope-copy > strong' }).closest('.income-flow-row')).toHaveAttribute('data-expanded', 'true')
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
    expect(screen.getByText('Bitcoin', { selector: '.income-envelope-copy > strong' }).closest('.income-flow-row')).toHaveAttribute('data-expanded', 'false')
  })
})
