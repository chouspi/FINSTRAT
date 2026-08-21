import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DATA_CHANGED_EVENT, DATA_REFRESH_INTERVAL_MS } from './dataRefresh'

export function DataRefreshProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({ refetchType: 'active' })
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const interval = window.setInterval(refresh, DATA_REFRESH_INTERVAL_MS)
    window.addEventListener(DATA_CHANGED_EVENT, refresh)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener(DATA_CHANGED_EVENT, refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [queryClient])

  return children
}
