import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataRefreshProvider } from './lib/DataRefreshProvider.tsx'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DataRefreshProvider>
        <App />
      </DataRefreshProvider>
    </QueryClientProvider>
  </StrictMode>,
)
