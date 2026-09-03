import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input) => {
      const url = String(input)
      const settings = { defaultCapitalCzk: 23000, withoutDebtBtcPercent: 85, withoutDebtCashPercent: 15, withDebtBtcPercent: 60, withDebtDebtPercent: 25, withDebtCashPercent: 15, cashAccountIban: 'CZ6508000000192000145399', coinmateIban: 'CZ6508000000192000145399', coinmateVariableSymbol: '123456', coinmateRecipientMessage: 'Old message' }
      if (url.endsWith('/income-plan/overview')) return { ok: true, status: 200, json: async () => ({ settings, debts: [] }) } as Response
      if (url.endsWith('/identity/antiforgery')) return { ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response
      if (url.endsWith('/income-plan/settings')) return { ok: true, status: 200, json: async () => settings } as Response
      const strategySettings = { btcTaxPeriodYears: 3, checkpointAuto: true, checkpointActivationThresholdCzk: 100000, checkpointTriggerFloorCzk: 20000, checkpointTriggerPercent: 10, realizationStepProfitCzk: 20000, realizationStepTransferCzk: 10000, vwceRentRatePercent: 2 }
      if (url.endsWith('/strategy/overview')) return { ok: true, status: 200, json: async () => ({ settings: strategySettings }) } as Response
      if (url.endsWith('/strategy/settings')) return { ok: true, status: 200, json: async () => strategySettings } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('edits and saves both Income plan percentage profiles', async () => {
    const user = userEvent.setup()
    const router = createTestRouter('/settings')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    expect(await screen.findByText('Pravidla rozdělení příjmu')).toBeInTheDocument()
    expect(screen.getByLabelText('Bez spotřebitelských dluhů BTC')).toHaveValue(85)
    expect(screen.getByLabelText('S aktivními dluhy Dluhy')).toHaveValue(25)
    const iban = screen.getByLabelText('Cash účet (IBAN)')
    expect(iban).toHaveValue('CZ6508000000192000145399')
    await user.clear(iban)
    await user.type(iban, 'CZ12 3456 7890 1234 5678 9012')
    expect(screen.getByLabelText('Coinmate IBAN / účet')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Odemknout Coinmate platební údaje' }))
    const warning = screen.getByRole('alertdialog', { name: 'Odemknout platební údaje?' })
    expect(within(warning).getByText(/ovlivní všechny budoucí Coinmate QR/)).toBeInTheDocument()
    await user.click(within(warning).getByRole('button', { name: 'Ano, upravit údaje' }))
    expect(screen.getByLabelText('Coinmate IBAN / účet')).toBeEnabled()
    await user.clear(screen.getByLabelText('Coinmate IBAN / účet'))
    await user.type(screen.getByLabelText('Coinmate IBAN / účet'), 'CZ65 0800 0000 1920 0014 5399')
    await user.clear(screen.getByLabelText('Coinmate variabilní symbol'))
    await user.type(screen.getByLabelText('Coinmate variabilní symbol'), '987654')
    await user.clear(screen.getByLabelText('Coinmate zpráva pro příjemce'))
    await user.type(screen.getByLabelText('Coinmate zpráva pro příjemce'), 'New deposit')
    await user.click(screen.getByRole('button', { name: 'Uložit' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/income-plan/settings') && options?.method === 'PUT')).toBe(true))
    const saveCall = vi.mocked(fetch).mock.calls.find(([url, options]) => String(url).endsWith('/income-plan/settings') && options?.method === 'PUT')
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({ cashAccountIban: 'CZ12 3456 7890 1234 5678 9012', coinmateIban: 'CZ65 0800 0000 1920 0014 5399', coinmateVariableSymbol: '987654', coinmateRecipientMessage: 'New deposit' })
  })

  it('opens and saves BTC strategy settings in its own tab', async () => {
    const user = userEvent.setup()
    const router = createTestRouter('/settings?tab=strategy')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    expect(await screen.findByText('Checkpoint a realizace zisku')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'BTC Strategie' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Práh aktivace checkpointu')).toHaveValue(100000)
    expect(screen.getByLabelText('Trigger jako podíl checkpointu')).toHaveValue(10)
    await user.click(screen.getByRole('button', { name: 'Uložit' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith('/strategy/settings') && options?.method === 'PUT')).toBe(true))
  })
})
