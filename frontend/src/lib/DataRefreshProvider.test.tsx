import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataRefreshProvider } from './DataRefreshProvider'
import { DATA_REFRESH_INTERVAL_MS } from './dataRefresh'

describe('DataRefreshProvider', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('refreshes active queries every five seconds while the page is visible', async () => {
    vi.useFakeTimers()
    const queryFn = vi.fn().mockResolvedValue('ok')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Consumer() {
      useQuery({ queryKey: ['test-data'], queryFn })
      return null
    }

    render(
      <QueryClientProvider client={client}>
        <DataRefreshProvider><Consumer /></DataRefreshProvider>
      </QueryClientProvider>,
    )
    await act(async () => { await Promise.resolve() })
    expect(queryFn).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(DATA_REFRESH_INTERVAL_MS)
      await Promise.resolve()
    })
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('does not periodically refresh wealth and strategy queries', async () => {
    vi.useFakeTimers()
    const wealthQuery = vi.fn().mockResolvedValue('wealth')
    const strategyQuery = vi.fn().mockResolvedValue('strategy')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Consumer() {
      useQuery({ queryKey: ['wealth', 'history', 30], queryFn: wealthQuery })
      useQuery({ queryKey: ['strategy', 'overview'], queryFn: strategyQuery })
      return null
    }

    render(<QueryClientProvider client={client}><DataRefreshProvider><Consumer /></DataRefreshProvider></QueryClientProvider>)
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      vi.advanceTimersByTime(DATA_REFRESH_INTERVAL_MS)
      await Promise.resolve()
    })

    expect(wealthQuery).toHaveBeenCalledTimes(1)
    expect(strategyQuery).toHaveBeenCalledTimes(1)
  })
})
