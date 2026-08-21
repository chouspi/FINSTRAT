import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  )
}

describe('hidden login', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps login hidden until the third BTC logo click', async () => {
    const user = userEvent.setup()
    renderApp()
    const logo = screen.getByRole('button', { name: 'FINSTRAT domů' })

    await user.click(logo)
    await user.click(logo)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(logo)
    expect(screen.getByRole('dialog', { name: 'Přihlášení' })).toBeInTheDocument()
  })

  it('does not expose account switching in default mode', () => {
    renderApp()
    expect(screen.queryByText(/přihl/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Odhlásit' })).not.toBeInTheDocument()
  })
})
