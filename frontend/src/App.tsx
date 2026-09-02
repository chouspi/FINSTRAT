import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  ArrowLeftRight,
  Banknote,
  Bitcoin,
  BookOpenCheck,
  ChartNoAxesCombined,
  ChevronRight,
  CircleGauge,
  Landmark,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  ShieldCheck,
  TrendingUp,
  WalletCards,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { antiforgeryToken, apiRequest } from './lib/api'
import type { StrategyOverview } from './lib/strategy'
import './App.css'

type CurrentUser = {
  id: string
  userName: string
  displayName: string
  email: string | null
  isDefault: boolean
  householdId: string
  role: string
  sessionExpiresAt: string | null
}

type BtcPrice = {
  priceUsd: number
  priceCzk: number
  change24hPercent: number
  observedAt: string
  source: string
  isStale: boolean
}

type VwceSidebarOverview = {
  totals: { shares: number; costBasisCzk: number; rentRatePercent: number }
}

type VwcePrice = { priceCzk: number }

type NavItem = {
  label: string
  icon: LucideIcon
  href?: '/' | '/wealth' | '/strategy' | '/taxes' | '/income-plan' | '/bitcoin' | '/vwce' | '/debts' | '/settings'
}

const navigation: { label: string; items: NavItem[] }[] = [
  {
    label: 'Navigace',
    items: [
      { label: 'Dashboard', icon: CircleGauge, href: '/' },
      { label: 'Income plán', icon: Banknote, href: '/income-plan' },
      { label: 'Jmění', icon: ChartNoAxesCombined, href: '/wealth' },
      { label: 'Strategie', icon: TrendingUp, href: '/strategy' },
      { label: 'BTC Účty', icon: Bitcoin, href: '/bitcoin' },
      { label: 'VWCE', icon: Landmark, href: '/vwce' },
      { label: 'Dluhy', icon: WalletCards, href: '/debts' },
      { label: 'Daně', icon: BookOpenCheck, href: '/taxes' },
      { label: 'Nastavení', icon: Settings, href: '/settings' },
    ],
  },
]

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const percentFormatter = new Intl.NumberFormat('en-US', {
  signDisplay: 'always',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const czkFormatter = new Intl.NumberFormat('cs-CZ', {
  style: 'currency',
  currency: 'CZK',
  maximumFractionDigits: 0,
})

function App() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [loginOpen, setLoginOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const logoClicks = useRef<number[]>([])
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebarCloseButton = useRef<HTMLButtonElement>(null)
  const currentUser = useQuery({
    queryKey: ['identity', 'me'],
    queryFn: () => apiRequest<CurrentUser>('/api/identity/me'),
    retry: false,
  })
  const btcPrice = useQuery({
    queryKey: ['market-data', 'btc-price'],
    queryFn: () => apiRequest<BtcPrice>('/api/market-data/btc-price'),
    retry: false,
  })
  const vwceOverview = useQuery({
    queryKey: ['vwce', 'overview'],
    queryFn: () => apiRequest<VwceSidebarOverview>('/api/vwce/overview'),
    retry: false,
  })
  const vwcePrice = useQuery({
    queryKey: ['market-data', 'vwce-price'],
    queryFn: () => apiRequest<VwcePrice>('/api/market-data/vwce-price'),
    retry: false,
  })
  const strategyOverview = useQuery({
    queryKey: ['strategy', 'overview'],
    queryFn: () => apiRequest<StrategyOverview>('/api/strategy/overview'),
    retry: false,
  })
  const logout = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await apiRequest<void>('/api/identity/logout', {
        method: 'POST',
        headers: { 'X-CSRF-TOKEN': token },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['identity', 'me'] })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bitcoin'] }),
        queryClient.invalidateQueries({ queryKey: ['vwce'] }),
        queryClient.invalidateQueries({ queryKey: ['wealth'] }),
      ])
    },
  })
  const renewSession = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await apiRequest<void>('/api/identity/renew', {
        method: 'POST',
        headers: { 'X-CSRF-TOKEN': token },
      })
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['identity', 'me'] })
    },
  })

  useEffect(() => {
    if (!sidebarOpen) return

    const menuTrigger = menuButton.current
    document.body.classList.add('sidebar-open')
    sidebarCloseButton.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)

    return () => {
      document.body.classList.remove('sidebar-open')
      document.removeEventListener('keydown', closeOnEscape)
      menuTrigger?.focus()
    }
  }, [sidebarOpen])

  useEffect(() => {
    if (!moreOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.body.classList.add('bottom-nav-open')
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.classList.remove('bottom-nav-open')
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [moreOpen])

  function handleLogoClick() {
    const now = Date.now()
    logoClicks.current = [...logoClicks.current.filter((time) => now - time < 1200), now]
    if (logoClicks.current.length === 3) {
      logoClicks.current = []
      setLoginOpen(true)
    }
  }

  const signedInUser = currentUser.data?.isDefault === false ? currentUser.data : null
  const priceUsd = btcPrice.data?.priceUsd
  const displayedBtcPrice = typeof priceUsd === 'number' && Number.isFinite(priceUsd)
    ? usdFormatter.format(priceUsd)
    : '$ —'
  const change24h = btcPrice.data?.change24hPercent
  const displayedChange24h = typeof change24h === 'number' && Number.isFinite(change24h)
    ? `${percentFormatter.format(change24h)}%`
    : null
  const change24hClass = typeof change24h !== 'number' || change24h === 0
    ? 'change-neutral'
    : change24h > 0 ? 'change-positive' : 'change-negative'
  const priceCzk = btcPrice.data?.priceCzk
  const displayedBtcPriceCzk = typeof priceCzk === 'number' && Number.isFinite(priceCzk)
    ? czkFormatter.format(priceCzk)
    : null
  const vwceTotals = vwceOverview.data?.totals
  const currentVwcePrice = vwcePrice.data?.priceCzk
  const vwceMonthlyRent = vwceTotals
    && typeof vwceTotals.shares === 'number'
    && typeof vwceTotals.rentRatePercent === 'number'
    && typeof currentVwcePrice === 'number'
    && Number.isFinite(currentVwcePrice)
    ? vwceTotals.shares * currentVwcePrice * vwceTotals.rentRatePercent / 100 / 12
    : null

  return (
    <div className={`app-shell${sidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}`}>
      {sidebarOpen && (
        <button className="sidebar-scrim" type="button" aria-label="Zavřít navigaci" onClick={() => setSidebarOpen(false)} />
      )}

      <aside id="primary-navigation" className={`sidebar${sidebarOpen ? ' sidebar--open' : ''}${sidebarCollapsed ? ' sidebar--collapsed' : ''}`} aria-label="Hlavní navigace">
        <div className="brand-row">
          <button className="brand-mark" type="button" aria-label="FINSTRAT domů" onClick={handleLogoClick}>
            <Bitcoin size={19} strokeWidth={2.2} />
          </button>
          <div className="brand-copy">
            <strong>FINSTRAT</strong>
            <span>Osobní finance</span>
          </div>
          <button ref={sidebarCloseButton} className="sidebar-close" type="button" aria-label="Zavřít navigaci" onClick={() => setSidebarOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Hlavní navigace">
          {navigation.map((section) => (
            <div className="nav-section" key={section.label}>
              <p>{section.label}</p>
              {section.items.map((item) => {
                const Icon = item.icon
                const isActive = item.href === pathname
                const content = (
                  <>
                    <Icon size={18} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {isActive && <ChevronRight className="nav-arrow" size={15} />}
                  </>
                )
                if (item.href) {
                  return (
                    <Link
                      className={`nav-item${isActive ? ' nav-item--active' : ''}`}
                      to={item.href}
                      key={item.label}
                      title={sidebarCollapsed ? item.label : undefined}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setSidebarOpen(false)}
                    >
                      {content}
                    </Link>
                  )
                }
                return (
                  <button
                    className="nav-item"
                    type="button"
                    key={item.label}
                    title={sidebarCollapsed ? item.label : undefined}
                  >
                    {content}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-metrics">
          <div className="strategy-indicator">
            <div className="strategy-label">
              <span>{strategyOverview.data?.checkpointActive ? 'Trigger' : 'Aktivace'}</span>
              <strong>{strategyOverview.data?.recommendation === 'PRODAT' ? 'PRODAT' : `${Math.round(strategyOverview.data?.progressPercent ?? 0)} %`}</strong>
            </div>
            <div
              className="strategy-track"
              role="progressbar"
              aria-label="Průběh strategie"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(strategyOverview.data?.progressPercent ?? 0)}
            >
              <span style={{ width: `${Math.min(100, Math.max(0, strategyOverview.data?.progressPercent ?? 0))}%` }} />
            </div>
          </div>
          {vwceMonthlyRent !== null && (
            <div className="rent-indicator">
              <span>VWCE renta / měs.</span>
              <strong>{czkFormatter.format(vwceMonthlyRent)}</strong>
            </div>
          )}
          <div className="price-indicator" aria-label="Aktuální cena BTC v USD">
            <div className="price-heading">
              <span>BTC / USD</span>
              <button type="button" aria-label="Obnovit cenu BTC" onClick={() => void btcPrice.refetch()}><RefreshCw size={11} /></button>
            </div>
            <div className="price-value">
              <strong className={btcPrice.data?.isStale ? 'price-stale' : undefined}>
                {displayedBtcPrice}
              </strong>
              {displayedBtcPriceCzk && <small>{displayedBtcPriceCzk}</small>}
            </div>
          </div>
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-collapse" type="button" aria-label={sidebarCollapsed ? 'Rozbalit navigaci' : 'Sbalit navigaci'} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>{sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}</button>
        </div>
      </aside>

      <div className="content-shell">
        <header className="top-header">
          <div className="header-leading">
            <button
              ref={menuButton}
              className="mobile-menu"
              type="button"
              aria-label="Otevřít navigaci"
              aria-controls="primary-navigation"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </button>
            {signedInUser && (
              <div className="signed-in-user">
                <button
                  className="user-avatar"
                  type="button"
                  title="Prodloužit relaci o 15 minut"
                  aria-label="Prodloužit relaci o 15 minut"
                  disabled={renewSession.isPending}
                  onClick={() => renewSession.mutate()}
                >
                  {signedInUser.displayName.slice(0, 2).toUpperCase()}
                </button>
                <div>
                  <strong>{signedInUser.displayName}</strong>
                  <SessionRemaining expiresAt={signedInUser.sessionExpiresAt} />
                </div>
                <button type="button" aria-label="Odhlásit" onClick={() => logout.mutate()}>
                  <LogOut size={17} />
                </button>
              </div>
            )}
          </div>
          <div className="header-heading">
            <button className="mobile-login-logo" type="button" aria-label="Otevřít přihlášení" onClick={handleLogoClick}><Bitcoin size={18} strokeWidth={2.2} /></button>
             <h1 className="header-title">{pathname === '/bitcoin' ? 'BTC Účty' : pathname === '/vwce' ? 'VWCE' : pathname === '/debts' ? 'Dluhy' : pathname === '/income-plan' ? 'Income plán' : pathname === '/wealth' ? 'Jmění' : pathname === '/strategy' ? 'Strategie' : pathname === '/taxes' ? 'Daně' : pathname === '/settings' ? 'Nastavení' : 'Dashboard'}</h1>
          </div>
          {pathname === '/bitcoin' ? (
            <div className="header-actions">
              <button
                className="header-action header-action--secondary"
                type="button"
                onClick={() => void navigate({ to: '/bitcoin', search: { dialog: 'transfer' } })}
              >
                <ArrowLeftRight size={15} />
                <span>Převod</span>
              </button>
              <button
                className="header-action header-action--primary"
                type="button"
                onClick={() => void navigate({ to: '/bitcoin', search: { dialog: 'account' } })}
              >
                <Plus size={15} />
                <span>Přidat účet</span>
              </button>
            </div>
          ) : pathname === '/vwce' ? (
            <div className="header-actions">
              <button
                className="header-action header-action--secondary header-action--payout"
                type="button"
                onClick={() => void navigate({ to: '/vwce', search: { dialog: 'payout' } })}
              >
                <Banknote size={15} />
                <span>Vyplatit</span>
              </button>
              <button
                className="header-action header-action--primary"
                type="button"
                onClick={() => void navigate({ to: '/vwce', search: { dialog: 'account' } })}
              >
                <Plus size={15} />
                <span>Nový účet</span>
              </button>
            </div>
          ) : pathname === '/debts' ? (
            <div className="header-actions">
              <button className="header-action header-action--secondary" type="button" onClick={() => void navigate({ to: '/debts', search: { dialog: 'manage' } })}><SlidersHorizontal size={15} /><span>Správa dluhů</span></button>
              <button className="header-action header-action--secondary header-action--payout" type="button" onClick={() => void navigate({ to: '/debts', search: { dialog: 'payment' } })}><Banknote size={15} /><span>Zapsat splátku</span></button>
              <button className="header-action header-action--primary" type="button" onClick={() => void navigate({ to: '/debts', search: { dialog: 'debt' } })}><Plus size={15} /><span>Přidat dluh</span></button>
            </div>
          ) : pathname === '/income-plan' && signedInUser ? (
            <div className="header-actions">
              <button className="income-header-action" type="button" onClick={() => void navigate({ to: '/income-plan', search: { dialog: 'process' } })}><Banknote size={14} /><span>Zpracovat příjem</span></button>
            </div>
          ) : <div aria-hidden="true" />}
        </header>
        <main className="workspace" aria-label="Pracovní plocha"><Outlet /></main>
      </div>

      {moreOpen && <div className="more-sheet-backdrop" role="presentation" onClick={() => setMoreOpen(false)}><section className="more-sheet" aria-label="Další navigace" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><button className="sheet-brand" type="button" onClick={handleLogoClick}><Bitcoin size={15} /> Portfolio</button><button type="button" aria-label="Zavřít další navigaci" onClick={() => setMoreOpen(false)}><X size={18} /></button></div><Link to="/wealth" search={{ tab: undefined }} className={pathname === '/wealth' ? 'sheet-link active' : 'sheet-link'} onClick={() => setMoreOpen(false)}><ChartNoAxesCombined size={18} />Jmění</Link><Link to="/strategy" className={pathname === '/strategy' ? 'sheet-link active' : 'sheet-link'} onClick={() => setMoreOpen(false)}><TrendingUp size={18} />Strategie</Link><Link to="/debts" search={{ dialog: undefined }} className={pathname === '/debts' ? 'sheet-link active' : 'sheet-link'} onClick={() => setMoreOpen(false)}><WalletCards size={18} />Dluhy</Link><Link to="/taxes" className={pathname === '/taxes' ? 'sheet-link active' : 'sheet-link'} onClick={() => setMoreOpen(false)}><BookOpenCheck size={18} />Daně</Link><Link className={pathname === '/settings' ? 'sheet-link active' : 'sheet-link'} to="/settings" search={{ tab: undefined }} onClick={() => setMoreOpen(false)}><Settings size={18} />Nastavení</Link><div className="sheet-price"><span>BTC / USD</span><strong>{displayedBtcPrice}</strong>{displayedChange24h && <small className={change24hClass}>{displayedChange24h}</small>}</div></section></div>}

      <nav className="bottom-nav" aria-label="Mobilní navigace"><Link to="/" className={pathname === '/' ? 'active' : undefined}><CircleGauge size={20} /><span>Dashboard</span></Link><Link to="/income-plan" search={{ dialog: undefined }} className={pathname === '/income-plan' ? 'active' : undefined}><Banknote size={20} /><span>Income</span></Link><Link to="/bitcoin" search={{ dialog: undefined }} className={pathname === '/bitcoin' ? 'active' : undefined}><Bitcoin size={20} /><span>BTC Účty</span></Link><Link to="/vwce" search={{ dialog: undefined }} className={pathname === '/vwce' ? 'active' : undefined}><Landmark size={20} /><span>VWCE</span></Link><button type="button" className={pathname === '/wealth' || pathname === '/strategy' || pathname === '/taxes' || pathname === '/debts' || pathname === '/settings' || moreOpen ? 'active' : undefined} aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={20} /><span>Více</span></button></nav>

      {loginOpen && (
        <LoginDialog
          onClose={() => setLoginOpen(false)}
          onSuccess={async () => {
            await queryClient.invalidateQueries({ queryKey: ['identity', 'me'] })
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['bitcoin'] }),
              queryClient.invalidateQueries({ queryKey: ['vwce'] }),
              queryClient.invalidateQueries({ queryKey: ['debts'] }),
              queryClient.invalidateQueries({ queryKey: ['income-plan'] }),
              queryClient.invalidateQueries({ queryKey: ['wealth'] }),
            ])
            setLoginOpen(false)
          }}
        />
      )}
    </div>
  )
}

function SessionRemaining({ expiresAt }: { expiresAt: string | null }) {
  const [minutes, setMinutes] = useState<number | null>(null)

  useEffect(() => {
    if (!expiresAt) return
    const update = () => setMinutes(Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60_000)))
    const initialUpdate = window.setTimeout(update, 0)
    const interval = window.setInterval(update, 30_000)
    return () => {
      window.clearTimeout(initialUpdate)
      window.clearInterval(interval)
    }
  }, [expiresAt])

  if (!expiresAt || minutes === null) return <span>Soukromá relace</span>
  return <span>{minutes > 0 ? `Končí za ${minutes} min` : 'Relace končí'}</span>
}

function LoginDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => Promise<void> }) {
  const [rememberedIdentifier] = useState(() => localStorage.getItem('finstrat:last-username') ?? '')
  const clearRememberedOnFocus = useRef(rememberedIdentifier.length > 0)
  const [identifier, setIdentifier] = useState(rememberedIdentifier)
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await apiRequest<void>('/api/identity/login', {
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
