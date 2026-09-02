import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('StrategyPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/strategy/overview')) return { ok: true, status: 200, json: async () => ({
        settings: { btcTaxPeriodYears: 3, checkpointAuto: true, checkpointActivationThresholdCzk: 100000, checkpointTriggerFloorCzk: 20000, checkpointTriggerPercent: 10, realizationStepProfitCzk: 20000, realizationStepTransferCzk: 10000, vwceRentRatePercent: 2 },
        btcQuantity: .1, btcPriceCzk: 3000000, portfolioValueCzk: 300000, checkpointActive: true,
        checkpointValueCzk: 250000, profitCzk: 50000, profitPercent: 20, triggerCzk: 25000,
        progressPercent: 100, remainingCzk: 0, recommendedTransferCzk: 20000, recommendation: 'PRODAT',
      }) } as Response
      if (url.endsWith('/btc-price')) return { ok: true, status: 200, json: async () => ({ priceUsd: 75000, priceCzk: 3000000, change24hPercent: 1 }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('renders the active checkpoint and trigger progress without redundant settings detail', async () => {
    const router = createTestRouter('/strategy')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)
    const strategyPage = (await screen.findByText('TRIGGER DOSAŽEN')).closest<HTMLElement>('.strategy-page')!
    expect(within(strategyPage).getByText('PRODAT')).toBeInTheDocument()
    expect(within(strategyPage).getByText('Trigger překročen')).toBeInTheDocument()
    expect(within(strategyPage).queryByText('DETAIL VÝPOČTU')).not.toBeInTheDocument()
    expect(within(strategyPage).queryByRole('link', { name: /Upravit parametry strategie/ })).not.toBeInTheDocument()
  })
})
