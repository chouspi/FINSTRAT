import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bitcoin,
  BookOpenCheck,
  ChartNoAxesCombined,
  ChevronRight,
  CircleGauge,
  Coins,
  Landmark,
  LogOut,
  Menu,
  ReceiptText,
  Settings,
  ShieldCheck,
  TrendingUp,
  WalletCards,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import './App.css'

type CurrentUser = {
  id: string
  userName: string
  displayName: string
  email: string | null
  isDefault: boolean
  householdId: string
  role: string
}

type NavItem = {
  label: string
  icon: LucideIcon
  active?: boolean
}

const navigation: { label: string; items: NavItem[] }[] = [
  {
    label: 'Přehled',
    items: [
      { label: 'Dashboard', icon: CircleGauge, active: true },
      { label: 'Portfolio', icon: ChartNoAxesCombined },
      { label: 'Strategie', icon: TrendingUp },
    ],
  },
  {
    label: 'Majetek',
    items: [
      { label: 'Bitcoin', icon: Bitcoin },
      { label: 'VWCE', icon: Landmark },
      { label: 'Dluhy', icon: WalletCards },
      { label: 'Výdaje', icon: ReceiptText },
    ],
  },
  {
    label: 'Evidence',
    items: [
      { label: 'Časový test', icon: Coins },
      { label: 'Doklady', icon: BookOpenCheck },
    ],
  },
]

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options })
  if (!response.ok) throw new Error(response.status === 401 ? 'Neplatné přihlašovací údaje.' : 'Požadavek se nezdařil.')
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

async function antiforgeryToken() {
  const response = await request<{ token: string }>('/api/identity/antiforgery')
  return response.token
}

function App() {
  const queryClient = useQueryClient()
  const [loginOpen, setLoginOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const logoClicks = useRef<number[]>([])
  const currentUser = useQuery({
    queryKey: ['identity', 'me'],
    queryFn: () => request<CurrentUser>('/api/identity/me'),
    retry: false,
  })
  const logout = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await request<void>('/api/identity/logout', {
        method: 'POST',
        headers: { 'X-CSRF-TOKEN': token },
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['identity', 'me'] }),
  })

  function handleLogoClick() {
    const now = Date.now()
    logoClicks.current = [...logoClicks.current.filter((time) => now - time < 1200), now]
    if (logoClicks.current.length === 3) {
      logoClicks.current = []
      setLoginOpen(true)
    }
  }

  const signedInUser = currentUser.data?.isDefault === false ? currentUser.data : null

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button className="sidebar-scrim" type="button" aria-label="Zavřít navigaci" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`sidebar${sidebarOpen ? ' sidebar--open' : ''}`}>
        <div className="sidebar-topline" />
        <div className="brand-row">
          <button className="brand-mark" type="button" aria-label="FINSTRAT domů" onClick={handleLogoClick}>
            <Bitcoin size={19} strokeWidth={2.2} />
          </button>
          <div className="brand-copy">
            <strong>FINSTRAT</strong>
          </div>
          <button className="sidebar-close" type="button" aria-label="Zavřít navigaci" onClick={() => setSidebarOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Hlavní navigace">
          {navigation.map((section) => (
            <div className="nav-section" key={section.label}>
              <p>{section.label}</p>
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    className={`nav-item${item.active ? ' nav-item--active' : ''}`}
                    type="button"
                    key={item.label}
                    aria-current={item.active ? 'page' : undefined}
                  >
                    <Icon size={18} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {item.active && <ChevronRight className="nav-arrow" size={15} />}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-metrics">
          <div className="strategy-indicator">
            <div className="strategy-label">
              <span>Strategy bar</span>
              <strong>—</strong>
            </div>
            <div
              className="strategy-track"
              role="progressbar"
              aria-label="Průběh strategie"
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span />
            </div>
          </div>
          <div className="price-indicator" aria-label="Aktuální cena BTC v USD">
            <span>BTC / USD</span>
            <strong>$ —</strong>
          </div>
        </div>

        <div className="sidebar-footer">
          <button className="nav-item settings-item" type="button">
            <Settings size={18} strokeWidth={1.8} />
            <span>Nastavení</span>
          </button>
        </div>
      </aside>

      <div className="content-shell">
        <header className="top-header">
          <div className="header-leading">
            <button
              className="mobile-menu"
              type="button"
              aria-label="Otevřít navigaci"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </button>
            {signedInUser && (
              <div className="signed-in-user">
                <div className="user-avatar">{signedInUser.displayName.slice(0, 2).toUpperCase()}</div>
                <div>
                  <strong>{signedInUser.displayName}</strong>
                  <span>Relace končí za 15 minut</span>
                </div>
                <button type="button" aria-label="Odhlásit" onClick={() => logout.mutate()}>
                  <LogOut size={17} />
                </button>
              </div>
            )}
          </div>
          <h1 className="header-title">Dashboard</h1>
          <div aria-hidden="true" />
        </header>
        <main className="workspace" aria-label="Pracovní plocha" />
      </div>

      {loginOpen && (
        <LoginDialog
          onClose={() => setLoginOpen(false)}
          onSuccess={async () => {
            await queryClient.invalidateQueries({ queryKey: ['identity', 'me'] })
            setLoginOpen(false)
          }}
        />
      )}
    </div>
  )
}

function LoginDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => Promise<void> }) {
  const [rememberedIdentifier] = useState(() => localStorage.getItem('finstrat:last-username') ?? '')
  const clearRememberedOnFocus = useRef(rememberedIdentifier.length > 0)
  const [identifier, setIdentifier] = useState(rememberedIdentifier)
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await request<void>('/api/identity/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({ identifier, password }),
      })
    },
    onSuccess: async () => {
      localStorage.setItem('finstrat:last-username', identifier.trim())
      await onSuccess()
    },
  })

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="dialog-close" type="button" aria-label="Zavřít přihlášení" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="dialog-seal"><ShieldCheck size={21} /></div>
        <p className="dialog-kicker">RESTRICTED ACCESS</p>
        <h1 id="login-title">Přihlášení</h1>
        <p className="dialog-description">Otevře soukromou relaci na 15 minut.</p>
        <form onSubmit={(event) => { event.preventDefault(); login.mutate() }}>
          <label>
            Uživatelské jméno
            <input
              autoFocus={rememberedIdentifier.length === 0}
              autoComplete="username"
              value={identifier}
              onFocus={() => {
                if (clearRememberedOnFocus.current && identifier === rememberedIdentifier) {
                  setIdentifier('')
                  clearRememberedOnFocus.current = false
                }
              }}
              onChange={(event) => {
                clearRememberedOnFocus.current = false
                setIdentifier(event.target.value)
              }}
              required
            />
          </label>
          <label>
            Heslo
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {login.error && <p className="form-error" role="alert">{login.error.message}</p>}
          <button className="login-submit" type="submit" disabled={login.isPending}>
            {login.isPending ? 'Ověřuji…' : 'Otevřít relaci'}
          </button>
        </form>
      </section>
    </div>
  )
}

export default App
