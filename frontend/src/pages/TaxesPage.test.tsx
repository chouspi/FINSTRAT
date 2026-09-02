import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('TaxesPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/taxes/overview')) return { ok: true, status: 200, json: async () => ({
        btcTaxPeriodYears: 3,
        taxFreeBtc: 0.02,
        taxableBtc: 0.08,
        nextTimeTestDate: '2027-08-27',
        lots: [{ id: 'lot', accountName: 'Trezor', remainingQuantityBtc: 0.08, unitPriceCzk: 2000000, taxAcquiredAt: '2024-08-27', timeTestDate: '2027-08-27', isTimeTestSatisfied: false }],
        deferredVwceCzk: 12000,
        recommendedTransferCzk: 0,
        canDeferRecommendedTransfer: false,
      }) } as Response
      return { ok: true, status: 200, json: async () => ({ id: 'default', userName: 'default', displayName: 'Default', isDefault: true, householdId: 'household', role: 'owner' }) } as Response
    }))
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('renders the tax metrics and lot calendar from the overview endpoint', async () => {
    const router = createTestRouter('/taxes')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    expect(await screen.findByText('KALENDÁŘ OSVOBOZENÍ')).toBeInTheDocument()
    expect(screen.getByText('Trezor')).toBeInTheDocument()
    expect(screen.getByText('VWCE místo BTC pool')).toBeInTheDocument()
    expect(screen.getByText(/12[  ]000[  ]Kč/)).toBeInTheDocument()
    expect(screen.queryByText(/Orientační přehled/)).not.toBeInTheDocument()
  })
})
