import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('LastDayIGambledPage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'samuel', displayName: 'Samuel', isDefault: false }) })))
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('reveals the first loss and keeps four cards on the page', async () => {
    const router = createTestRouter('/last-day-i-gambled')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)
    const user = userEvent.setup()

    expect(await screen.findByText('10. 9. 2026')).toBeInTheDocument()
    const card = screen.getByRole('button', { name: /ok, mam po vyplate 12k/ })
    expect(card).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByText(/^0[1-4]$/)).toHaveLength(4)
    await user.click(card)
    expect(card).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('jo? a do kdyz ti polymarket nabidne pro deposit falesny účet?')).toBeInTheDocument()
    expect(screen.getByText('−3,5k')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Falešný Polymarket deposit účet' })).toBeInTheDocument()
  })
})
