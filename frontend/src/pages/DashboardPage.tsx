import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, CircleGauge, PiggyBank } from 'lucide-react'
import { apiRequest } from '../lib/api'
import type { StrategyOverview } from '../lib/strategy'
import type { WealthTrendInput } from '../lib/wealthTrend'
import './DashboardPage.css'

type WealthPoint = WealthTrendInput & {
  snapshotAt: string
  btcValueCzk: number
  vwceValueCzk: number
  mortgageDebtCzk: number
}
type WealthHistory = { current: WealthPoint | null; points: WealthPoint[] }
type VglaOverview = { totals: { shares: number; rentRatePercent: number; rentPoolCzk: number } }
type VglaPrice = { priceCzk: number; isStale: boolean }

const czk = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
const compactCzk = new Intl.NumberFormat('cs-CZ', { notation: 'compact', style: 'currency', currency: 'CZK', maximumFractionDigits: 1 })
const shortDate = new Intl.DateTimeFormat('cs-CZ', { month: 'short', year: 'numeric' })

export function DashboardPage() {
  const navigate = useNavigate()
  const wealth = useQuery({ queryKey: ['wealth', 'history', 30], queryFn: () => apiRequest<WealthHistory>('/api/wealth/history?days=30'), retry: false })
  const strategy = useQuery({ queryKey: ['strategy', 'overview'], queryFn: () => apiRequest<StrategyOverview>('/api/strategy/overview'), retry: false })
  const vgla = useQuery({ queryKey: ['vgla', 'overview'], queryFn: () => apiRequest<VglaOverview>('/api/vgla/overview'), retry: false })
  const vglaPrice = useQuery({ queryKey: ['market-data', 'vgla-price'], queryFn: () => apiRequest<VglaPrice>('/api/market-data/vgla-price'), retry: false })
  const points = normalizePoints(wealth.data?.points)

  return <section className="dashboard-page">
    <section className="dashboard-chart-panel" aria-labelledby="dashboard-chart-title">
      <div className="dashboard-panel-header">
        <span id="dashboard-chart-title">Čisté jmění</span>
        <button className="dashboard-wealth-link" type="button" onClick={() => void navigate({ to: '/wealth', search: { tab: 'net' } })}>Detail <ChevronRight size={14} /></button>
      </div>
      <NetWorthView points={points} loading={wealth.isPending} error={wealth.isError} />
    </section>
    <div className="dashboard-focus-grid">
      <StrategyCard data={strategy.data} loading={strategy.isPending} error={strategy.isError} onClick={() => void navigate({ to: '/strategy' })} />
      <RentCard overview={vgla.data} price={vglaPrice.data} loading={vgla.isPending || vglaPrice.isPending} error={vgla.isError || vglaPrice.isError} onClick={() => void navigate({ to: '/vgla', search: { dialog: undefined } })} />
    </div>
  </section>
}

function NetWorthView({ points, loading, error }: { points: WealthPoint[]; loading: boolean; error: boolean }) {
  const first = points[0]
  const current = points.at(-1)
  const change = current && first ? current.trackedNetWorthCzk! - first.trackedNetWorthCzk! : null
  return <div className="dashboard-chart-content">
    <div className="dashboard-chart-copy">
      <strong className={change === null ? undefined : change > 0 ? 'positive' : 'negative'}>{change === null ? '—' : `${change > 0 ? '+' : ''}${czk.format(change)}`}</strong>
      <small>{change === null ? 'Historie zatím není dostupná' : 'za poslední měsíc'}</small>
    </div>
    <DashboardChart history={points.map((point) => ({ date: point.date, value: point.trackedNetWorthCzk! }))} ariaLabel="Vývoj čistého jmění" loading={loading} error={error} />
  </div>
}

function DashboardChart({ history, projection = [], ariaLabel, loading, error }: { history: { date: string; value: number }[]; projection?: { date: string; value: number }[]; ariaLabel: string; loading: boolean; error: boolean }) {
  const gradientId = useId().replaceAll(':', '')
  const all = [...history, ...projection.slice(1)].filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(`${point.date}T00:00:00Z`)))
  if (loading) return <div className="dashboard-chart-state" role="status">Načítám historii…</div>
  if (error) return <div className="dashboard-chart-state error" role="alert">Historii se nepodařilo načíst.</div>
  if (history.length < 2 || all.length < 2) return <div className="dashboard-chart-state">Pro graf zatím není dost záznamů.</div>
  const width = 900, height = 250, padX = 18, padY = 18
  const times = all.map((point) => Date.parse(`${point.date}T00:00:00Z`))
  const values = all.map((point) => point.value)
  const minTime = Math.min(...times), maxTime = Math.max(...times)
  const rawMin = Math.min(...values), rawMax = Math.max(...values)
  const spread = Math.max(rawMax - rawMin, Math.abs(rawMax) * .08, 1)
  const min = rawMin - spread * .12, max = rawMax + spread * .12
  const x = (date: string) => padX + (Date.parse(`${date}T00:00:00Z`) - minTime) / Math.max(1, maxTime - minTime) * (width - padX * 2)
  const y = (value: number) => height - padY - (value - min) / (max - min) * (height - padY * 2)
  const path = (items: { date: string; value: number }[]) => items.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.date)} ${y(point.value)}`).join(' ')
  const historyPath = path(history)
  const projectionPath = projection.length > 1 ? path(projection) : ''
  const area = `${historyPath} L ${x(history.at(-1)!.date)} ${height - padY} L ${x(history[0].date)} ${height - padY} Z`
  return <div className="dashboard-chart-visual">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--green)" stopOpacity=".2"/><stop offset="1" stopColor="var(--green)" stopOpacity="0"/></linearGradient></defs>
      <path className="dashboard-chart-area" d={area} fill={`url(#${gradientId})`} />
      <path className="dashboard-history-line" d={historyPath} />
      {projectionPath && <path className="dashboard-projection-line" d={projectionPath} />}
    </svg>
    <div className="dashboard-chart-axis"><span>{shortDate.format(new Date(`${all[0].date}T12:00:00`))}</span>{projectionPath && <b>Odhad</b>}<span>{shortDate.format(new Date(`${all.at(-1)!.date}T12:00:00`))}</span></div>
    <div className="dashboard-chart-scale"><span>{compactCzk.format(rawMax)}</span><span>{compactCzk.format(rawMin)}</span></div>
  </div>
}

function StrategyCard({ data, loading, error, onClick }: { data?: StrategyOverview; loading: boolean; error: boolean; onClick: () => void }) {
  const valid = data && [data.portfolioValueCzk, data.progressPercent, data.profitCzk, data.triggerCzk].every(Number.isFinite)
  const recommendation = valid ? data.recommendation : loading ? 'NAČÍTÁM' : 'NEDOSTUPNÉ'
  return <button className="dashboard-focus-card dashboard-strategy-card" type="button" onClick={onClick}>
    <div className="dashboard-card-header"><span><CircleGauge size={17} />BTC strategie</span><ChevronRight size={15} /></div>
    <div className="dashboard-card-primary"><span>Stav strategie</span><strong className={recommendation === 'PRODAT' ? 'positive' : undefined}>{recommendation}</strong><small>{error ? 'Strategii se nepodařilo načíst' : valid ? `Zisk od checkpointu ${czk.format(data.profitCzk)}` : 'Načítám aktuální stav'}</small></div>
    <div className="dashboard-strategy-progress"><div><span style={{ width: `${valid ? Math.min(100, Math.max(0, data.progressPercent)) : 0}%` }} /></div><small>{valid ? `Trigger ${czk.format(data.triggerCzk)}` : 'Trigger'}</small><strong>{valid ? `${Math.round(data.progressPercent)} %` : '—'}</strong></div>
    {valid && data.recommendedTransferCzk > 0 && <p>Připraveno k přesunu do VGLA <b>{czk.format(data.recommendedTransferCzk)}</b></p>}
  </button>
}

function RentCard({ overview, price, loading, error, onClick }: { overview?: VglaOverview; price?: VglaPrice; loading: boolean; error: boolean; onClick: () => void }) {
  const totals = overview?.totals
  const valid = Boolean(totals && Number.isFinite(totals.shares) && Number.isFinite(totals.rentRatePercent) && Number.isFinite(price?.priceCzk))
  const value = valid ? totals!.shares * price!.priceCzk : null
  const annual = value === null ? null : value * totals!.rentRatePercent / 100
  const monthly = annual === null ? null : annual / 12
  return <button className="dashboard-focus-card dashboard-rent-card" type="button" onClick={onClick}>
    <div className="dashboard-card-header"><span><PiggyBank size={17} />VGLA renta</span><ChevronRight size={15} /></div>
    <div className="dashboard-card-primary"><span>Měsíční renta</span><strong>{monthly === null ? '—' : czk.format(monthly)}</strong><small>{error ? 'Rentu se nepodařilo načíst' : loading ? 'Načítám portfolio…' : `${totals?.rentRatePercent ?? 0} % p.a. · ročně ${czk.format(annual ?? 0)}`}</small></div>
    <div className="dashboard-rent-footer"><div><span>Renta pool</span><strong>{czk.format(totals?.rentPoolCzk ?? 0)}</strong></div><div><span>Další dostupná renta</span><strong>{czk.format((totals?.rentPoolCzk ?? 0) + (monthly ?? 0))}</strong></div></div>
    {price?.isStale && <p>Tržní cena je dočasně zastaralá.</p>}
  </button>
}

function normalizePoints(value: WealthPoint[] | undefined) {
  if (!Array.isArray(value)) return []
  return value.filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.trackedNetWorthCzk) && Number.isFinite(point.grossAssetsCzk)).sort((a, b) => a.date.localeCompare(b.date))
}
