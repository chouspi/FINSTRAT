import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { DataRefreshProvider } from './lib/DataRefreshProvider.tsx'
import './index.css'
import { createAppRouter } from './router.tsx'

const queryClient = new QueryClient()
const router = createAppRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DataRefreshProvider>
        <RouterProvider router={router} />
      </DataRefreshProvider>
    </QueryClientProvider>
  </StrictMode>,
)
