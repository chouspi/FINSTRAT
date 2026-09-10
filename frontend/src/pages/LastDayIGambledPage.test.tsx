import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRouter } from '../router'

describe('LastDayIGambledPage', () => {
  beforeEach(() => {
    let count = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/identity/me')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'samuel', displayName: 'Samuel', isDefault: false }) } as Response)
      if (url.endsWith('/identity/antiforgery')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ token: 'csrf' }) } as Response)
      if (url.endsWith('/identity/gambling-counter')) {
        if (init?.method === 'POST') count += 1
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ count }) } as Response)
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('reveals the first loss and keeps four cards on the page', async () => {
    const router = createTestRouter('/last-day-i-gambled')
    await router.load()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)
    const user = userEvent.setup()

    expect(await screen.findByRole('heading', { name: 'Dneska se ti chce gamblit, jo?' })).toBeInTheDocument()
    expect(await screen.findByText('Pamatuješ na 10. 9. 2026, když jsi progamblil výplatu?', {}, { timeout: 1_500 })).toBeInTheDocument()
    expect(await screen.findByText('Ne? Tak já ti to připomenu.', {}, { timeout: 1_500 })).toBeInTheDocument()
    const card = screen.getByRole('button', { name: /OK, mám po výplatě 12k/ })
    expect(card).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByText(/^0[1-4]$/)).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Falešný Polymarket deposit účet' })).toBeInTheDocument()
    await user.click(card)
    expect(card).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Jo? A co když ti Polymarket nabídne pro deposit falešný účet?')).toBeInTheDocument()
    expect(screen.getByText('−3,5k')).toBeInTheDocument()

    const secondCard = screen.getByRole('button', { name: /OK, Polymarket programovali kokoti/ })
    expect(secondCard).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('img', { name: 'Skóre 11 ku 3 a jeho pokračování' })).toBeInTheDocument()
    await user.click(secondCard)
    expect(secondCard).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Jo? A co když prohrají deset roundů po sobě?')).toBeInTheDocument()
    expect(screen.getByText('−8k')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Skóre 11 ku 3 a jeho pokračování' })).toBeInTheDocument()
    expect(screen.getAllByText(/^0[1-4]$/)).toHaveLength(3)
    const thirdCard = screen.getByRole('button', { name: /OK, dáme comeback na Tipáči/ })
    expect(thirdCard).toHaveAttribute('aria-expanded', 'false')
    await user.click(thirdCard)
    expect(thirdCard).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Jo? A co když thrownou 3v1 into 13:10?')).toBeInTheDocument()
    expect(screen.getByText('−500 Kč')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Skóre comebacku s handicapem minus 4,5' })).toBeInTheDocument()
    expect(screen.getAllByText(/^0[1-4]$/)).toHaveLength(4)
    const fourthCard = screen.getByRole('button', { name: /OK, i G2 jsou sráči/ })
    await user.click(fourthCard)
    expect(fourthCard).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Jo? A to si myslíš, že Astralis nemůže jednu mapu prodat?… Může…')).toBeInTheDocument()
    expect(screen.getByText('−2,5k')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Astralis prohrává proti týmu 5STAR' })).toHaveAttribute('aria-hidden', 'false')
    expect(await screen.findByText('−14,25k', {}, { timeout: 2_500 })).toBeInTheDocument()
    const counter = await screen.findByRole('button', { name: /Zase jsem tam poslal peníze/ }, { timeout: 7_000 })
    await user.click(counter)
    expect(counter).toHaveTextContent('1×')
    expect(fetch).toHaveBeenCalledWith('/api/identity/gambling-counter', expect.objectContaining({ method: 'POST', headers: { 'X-CSRF-TOKEN': 'csrf' }, credentials: 'same-origin' }))
  }, 12_000)
})
