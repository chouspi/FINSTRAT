import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('BitcoinPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/bitcoin/overview')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totals: { quantityBtc: 0.125, costBasisCzk: 120000, accountCount: 2, costBasisComplete: true },
            accounts: [{
              id: 'account-1', name: 'Trezor', description: 'Cold storage', ownerDisplayName: 'Samuel',
              quantityBtc: 0.125, costBasisCzk: 120000, costBasisComplete: true,
              lotCount: 2, disposalCount: 0, proofCount: 1, latestActivityAt: '2026-08-21T10:00:00Z',
              isOwnedByCurrentUser: true, canManage: true, canShareWithDefault: true, isSharedWithDefault: false,
              proofs: [{
                id: 'proof-1', note: 'Cold storage proof', sha256: 'a'.repeat(64),
                createdAt: '2026-08-20T10:00:00Z', anchoredAt: '2026-08-20T11:00:00Z',
              }],
            }, {
              id: 'account-2', name: 'Ledger', description: null, ownerDisplayName: 'Samuel',
              quantityBtc: 0, costBasisCzk: 0, costBasisComplete: true,
              lotCount: 0, disposalCount: 0, proofCount: 0, latestActivityAt: null,
              isOwnedByCurrentUser: false, canManage: true, canShareWithDefault: false, isSharedWithDefault: true, proofs: [],
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
            priceUsd: 75000, priceCzk: 1650000, change24hPercent: 2, observedAt: '2026-08-21T10:00:00Z', source: 'coinbase', isStale: false,
          }),
        } as Response
      }
      if (url.endsWith('/identity/antiforgery')) {
        return { ok: true, status: 200, json: async () => ({ token: 'csrf-token' }) } as Response
      }
      if (url.endsWith('/accounts/account-1/proofs')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{
            id: 'proof-1', content: 'Ownership proof', contentSizeBytes: 15,
            sha256: 'a'.repeat(64), anchorTxid: 'b'.repeat(64),
            anchoredAt: '2026-08-20T11:00:00Z', note: 'Cold storage proof',
            createdAt: '2026-08-20T10:00:00Z',
          }],
        } as Response
      }
      if (url.endsWith('/accounts/account-1/movements')) {
        return { ok: true, status: 200, json: async () => [{
          id: 'account-lot-1', accountId: 'account-1', accountName: 'Trezor', type: 'purchase',
          quantityBtc: 0.125, unitPriceCzk: 960000, occurredAt: '2026-08-21T10:00:00Z', txid: null, note: 'DCA na účtu',
          canEdit: true, canDelete: true,
        }] } as Response
      }
      if (url.endsWith('/accounts/account-2/movements')) return { ok: true, status: 200, json: async () => [] } as Response
      if (url.endsWith('/bitcoin/transfers')) {
        return { ok: true, status: 201, json: async () => ({ id: 'transfer-1' }) } as Response
      }
      if (url.endsWith('/bitcoin/purchases')) {
        return { ok: true, status: 201, json: async () => ({ id: 'purchase-1' }) } as Response
      }
      if (url.endsWith('/default-share')) {
        return { ok: true, status: 204 } as Response
      }
      if (url.endsWith('/bitcoin/movements/account-lot-1/purchase')) return { ok: true, status: 204 } as Response
      if (url.endsWith('/bitcoin/accounts/account-1')) {
        return init?.method === 'DELETE'
          ? { ok: true, status: 204 } as Response
          : { ok: true, status: 200, json: async () => ({ id: 'account-1', name: 'Trezor II' }) } as Response
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
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createTestRouter('/bitcoin')
    await router.load()
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'BTC Účty' })).toBeInTheDocument()
    const accountName = await screen.findByRole('button', { name: 'Trezor' })
    const account = accountName.closest('details')
    expect(account).not.toBeNull()
    expect(within(account as HTMLElement).getByText('Vlastník')).not.toBeVisible()
    await user.click(accountName)
    expect(await within(account as HTMLElement).findByRole('status')).toHaveTextContent('Název zkopírován')
    expect(within(account as HTMLElement).getByText('Vlastník')).not.toBeVisible()
    await user.click(within(account as HTMLElement).getByText('Cold storage'))
    expect(within(account as HTMLElement).getByText('Vlastník')).toBeVisible()
    expect(await within(account as HTMLElement).findByText('DCA na účtu')).toBeVisible()
    await user.click(within(account as HTMLElement).getByRole('button', { name: 'Upravit pohyb' }))
    expect(screen.getByRole('dialog', { name: 'Upravit nákup' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Uložit pohyb' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) => String(input).endsWith('/bitcoin/movements/account-lot-1/purchase') && options?.method === 'PUT')).toBe(true))
    await user.click(within(account as HTMLElement).getByRole('button', { name: 'Odstranit pohyb' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Odstranit nákup' })).getByRole('button', { name: 'Odstranit pohyb' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) => String(input).endsWith('/bitcoin/movements/account-lot-1/purchase') && options?.method === 'DELETE')).toBe(true))
    expect(within(account as HTMLElement).getByRole('button', { name: 'Upravit účet Trezor v detailu' })).toBeVisible()
    expect(within(account as HTMLElement).getByRole('button', { name: 'Odstranit účet Trezor v detailu' })).toBeVisible()
    await user.click(within(account as HTMLElement).getByRole('button', { name: /Doklady/ }))
    expect(await screen.findByText('Cold storage proof')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Upravit' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Přidat doklad' }))
    expect(screen.getByRole('heading', { name: 'Nový doklad vlastnictví' })).toBeVisible()
    expect((screen.getByLabelText('Text dokumentu') as HTMLTextAreaElement).value)
      .toContain('PROHLÁŠENÍ O VLASTNICTVÍ BITCOINOVÝCH ADRES')
    await user.click(screen.getByRole('button', { name: 'Zpět na seznam dokladů' }))
    await user.click(screen.getByRole('button', { name: 'Zavřít' }))
    const sharedAccount = screen.getByRole('button', { name: 'Ledger' }).closest('details') as HTMLElement
    await user.click(within(sharedAccount).getByText('Bez popisu'))
    expect(within(sharedAccount).getByRole('button', { name: 'Výběr' })).toBeEnabled()
    expect(within(sharedAccount).getByRole('button', { name: 'Přidat nákup' })).toBeEnabled()
    await user.click(within(account as HTMLElement).getByRole('button', { name: 'Vlastník' }))
    const sharingSwitch = within(account as HTMLElement).getByRole('switch', { name: 'Sdílet s defaultem' })
    expect(sharingSwitch).toHaveAttribute('aria-checked', 'false')
    await user.click(sharingSwitch)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/default-share'))).toBe(true)
    await user.click(within(account as HTMLElement).getByRole('button', { name: 'Přidat nákup' }))
    expect(screen.getByRole('dialog', { name: 'Přidat nákup' })).toBeVisible()
    await user.type(screen.getByLabelText('Množství BTC'), '0.01')
    await user.click(screen.getByRole('button', { name: /dosadit aktuální/ }))
    expect(screen.getByLabelText('Za BTC (Kč)')).toHaveValue('1650000.00')
    expect(screen.getByLabelText('Celková (Kč)')).toHaveValue('16500.00')
    await user.click(screen.getByRole('button', { name: 'Zavřít' }))
    await user.click(within(account as HTMLElement).getByRole('button', { name: 'Výběr' }))
    await user.click(screen.getByRole('button', { name: 'Životní výdaj' }))
    expect(screen.getByText('Kategorie výdaje')).toBeVisible()
    expect(screen.getByText(/Checkpoint:/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Zavřít' }))
    expect(screen.getAllByText('0.125 BTC').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/206[  ]250 Kč/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Samuel').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Nákup').length).toBeGreaterThan(0)
  })

  it('renames and soft-deletes an owned account from the closed row', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createTestRouter('/bitcoin')
    await router.load()
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    const ownedAccount = (await screen.findByRole('button', { name: 'Trezor' })).closest('details') as HTMLElement
    const sharedAccount = screen.getByRole('button', { name: 'Ledger' }).closest('details') as HTMLElement
    expect(within(sharedAccount).queryByRole('button', { name: /Upravit účet/ })).not.toBeInTheDocument()
    expect(within(sharedAccount).queryByRole('button', { name: /Odstranit účet/ })).not.toBeInTheDocument()

    await user.click(within(ownedAccount).getByRole('button', { name: 'Upravit účet Trezor' }))
    const nameInput = screen.getByLabelText('Název účtu')
    await user.clear(nameInput)
    await user.type(nameInput, 'Trezor II')
    await user.click(screen.getByRole('button', { name: 'Uložit název' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) =>
      String(input).endsWith('/bitcoin/accounts/account-1') && options?.method === 'PUT')).toBe(true))

    await user.click(within(ownedAccount).getByRole('button', { name: 'Odstranit účet Trezor' }))
    expect(screen.getByRole('dialog', { name: 'Odstranit BTC účet' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Odstranit účet' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) =>
      String(input).endsWith('/bitcoin/accounts/account-1') && options?.method === 'DELETE')).toBe(true))
  })

  it('submits an internal transfer with a fee and idempotency key', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createTestRouter('/bitcoin')
    await router.load()
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    await screen.findByText('Trezor')
    await user.click(screen.getByRole('button', { name: 'Převod' }))
    await user.type(screen.getByLabelText('Množství BTC'), '0.01')
    await user.type(screen.getByLabelText(/Poplatek BTC/), '0.0001')
    await user.click(screen.getByRole('button', { name: 'Provést převod' }))

    const transferCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/bitcoin/transfers'))
    expect(transferCall).toBeDefined()
    const options = transferCall?.[1] as RequestInit
    expect(options.headers).toEqual(expect.objectContaining({
      'X-CSRF-TOKEN': 'csrf-token',
      'Idempotency-Key': expect.any(String),
    }))
    expect(JSON.parse(String(options.body))).toEqual(expect.objectContaining({
      fromAccountId: 'account-1',
      toAccountId: 'account-2',
      grossQuantityBtc: '0.01',
      feeQuantityBtc: '0.0001',
    }))
  })

  it('accepts Czech decimal commas when creating a BTC purchase', async () => {
    const user = userEvent.setup()
    const router = createTestRouter('/bitcoin')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)

    const account = (await screen.findByRole('button', { name: 'Trezor' })).closest('details') as HTMLElement
    await user.click(within(account).getByText('Cold storage'))
    await user.click(within(account).getByRole('button', { name: 'Přidat nákup' }))
    await user.type(screen.getByLabelText('Množství BTC'), '0,01')
    await user.type(screen.getByLabelText('Celková (Kč)'), '10000')
    expect(screen.getByLabelText('Za BTC (Kč)')).toHaveValue('1000000.00')
    await user.click(within(screen.getByRole('dialog', { name: 'Přidat nákup' })).getByRole('button', { name: 'Přidat nákup' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, options]) => String(input).endsWith('/bitcoin/purchases') && options?.method === 'POST')).toBe(true))
    const purchase = vi.mocked(fetch).mock.calls.find(([input, options]) => String(input).endsWith('/bitcoin/purchases') && options?.method === 'POST')
    expect(purchase).toBeDefined()
    expect(JSON.parse(String((purchase![1] as RequestInit).body))).toMatchObject({ quantityBtc: '0.01', unitPriceCzk: '1000000.00' })
  })
})
