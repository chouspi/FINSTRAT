import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('BitcoinPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/bitcoin/overview')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totals: { quantityBtc: 0.125, costBasisCzk: 120000, accountCount: 1, costBasisComplete: true },
            accounts: [{
              id: 'account-1', name: 'Trezor', description: 'Cold storage', ownerDisplayName: 'Samuel',
              quantityBtc: 0.125, costBasisCzk: 120000, costBasisComplete: true,
              lotCount: 2, disposalCount: 0, proofCount: 1, latestActivityAt: '2026-08-21T10:00:00Z',
            }],
            recentMovements: [{
              id: 'lot-1', accountId: 'account-1', accountName: 'Trezor', type: 'purchase',
              quantityBtc: 0.125, unitPriceCzk: 960000, occurredAt: '2026-08-21T10:00:00Z',
              txid: null, note: 'DCA',
            }],
          }),
        } as Response
      }
      if (url.endsWith('/btc-price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            priceUsd: 75000, change24hPercent: 2, observedAt: '2026-08-21T10:00:00Z', source: 'coinbase', isStale: false,
          }),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'samuel', userName: 'samuel', displayName: 'Samuel', email: null,
          isDefault: false, householdId: 'household', role: 'owner', sessionExpiresAt: null,
        }),
      } as Response
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows owner-scoped accounts, totals and recent movements', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createTestRouter('/bitcoin')
    await router.load()
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'Bitcoin' })).toBeInTheDocument()
    expect(await screen.findByText('Trezor')).toBeInTheDocument()
    expect(screen.getAllByText('0.125 BTC').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Samuel').length).toBeGreaterThan(0)
    expect(screen.getByText('Nákup')).toBeInTheDocument()
  })
})
