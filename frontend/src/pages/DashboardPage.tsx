import { useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowDownRight, ArrowUpRight, Bitcoin, ChevronRight, Landmark, RefreshCw, TrendingUp, Wallet } from 'lucide-react'
import { apiRequest } from '../lib/api'
import { calculateIncomeAllocation, formatCzkInput, parseCzkInput } from '../lib/incomePlan'
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
type IncomeOverview = {
  settings: {
    defaultCapitalCzk: number
    withoutDebtBtcPercent: number
    withoutDebtCashPercent: number
    withDebtBtcPercent: number
    withDebtDebtPercent: number
    withDebtCashPercent: number
    deferredDebtPaymentCzk?: number
  }
  debts: { id: string; priority?: number; balanceCzk: number }[]
  scheduledDebtPaymentCzk?: number
}
type Timeframe = '1m' | '3m' | '1y' | 'all'

const TIMEFRAMES: { key: Timeframe; label: string; days: number }[] = [
  { key: '1m', label: '1M', days: 30 },
  { key: '3m', label: '3M', days: 90 },
  { key: '1y', label: '1R', days: 365 },
  { key: 'all', label: 'Vše', days: 3650 },
]

const czk = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
const compactCzk = new Intl.NumberFormat('cs-CZ', { notation: 'compact', style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
const chartDate = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })

export function DashboardPage() {
  const navigate = useNavigate()
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const selectedTimeframe = TIMEFRAMES.find((item) => item.key === timeframe)!
  const wealth = useQuery({
    queryKey: ['wealth', 'history', selectedTimeframe.days],
    queryFn: () => apiRequest<WealthHistory>(`/api/wealth/history?days=${selectedTimeframe.days}`),
    retry: false,
  })
  const strategy = useQuery({ queryKey: ['strategy', 'overview'], queryFn: () => apiRequest<StrategyOverview>('/api/strategy/overview'), retry: false })
  const income = useQuery({ queryKey: ['income-plan', 'overview'], queryFn: () => apiRequest<IncomeOverview>('/api/income-plan/overview'), retry: false })
  const vgla = useQuery({ queryKey: ['vgla', 'overview'], queryFn: () => apiRequest<VglaOverview>('/api/vgla/overview'), retry: false })
  const vglaPrice = useQuery({ queryKey: ['market-data', 'vgla-price'], queryFn: () => apiRequest<VglaPrice>('/api/market-data/vgla-price'), retry: false })
  const points = normalizePoints(wealth.data?.points)
  const monthlyWealth = useQuery({
    queryKey: ['wealth', 'history', 30],
    queryFn: () => apiRequest<WealthHistory>('/api/wealth/history?days=30'),
    retry: false,
  })
  const monthlyPoints = normalizePoints(monthlyWealth.data?.points)

  return <section className="dashboard-page">
    <div className="dashboard-content">
      <section className="dashboard-chart-panel" aria-labelledby="dashboard-chart-title">
        <div className="dashboard-panel-header">
          <div className="dashboard-heading-copy">
            <span className="dashboard-heading-icon"><TrendingUp size={19} /></span>
            <div><h2 id="dashboard-chart-title">Čisté jmění</h2></div>
          </div>
          <button className="dashboard-wealth-link" type="button" onClick={() => void navigate({ to: '/wealth', search: { tab: 'net' } })}>Detail <ChevronRight size={14} /></button>
        </div>
        <div className="dashboard-chart-toolbar">
          <NetWorthSummary points={monthlyPoints} loading={monthlyWealth.isPending} />
          <div className="dashboard-timeframes" role="group" aria-label="Období grafu">
            {TIMEFRAMES.map((item) => <button key={item.key} type="button" className={timeframe === item.key ? 'active' : undefined} aria-pressed={timeframe === item.key} onClick={() => setTimeframe(item.key)}>{item.label}</button>)}
          </div>
        </div>
        <DashboardChart history={points.map((point) => ({ date: point.date, value: point.trackedNetWorthCzk! }))} loading={wealth.isPending} fetching={wealth.isFetching} error={wealth.isError} onRetry={() => void wealth.refetch()} />
      </section>
      <div className="dashboard-focus-grid">
        <StrategyCard data={strategy.data} loading={strategy.isPending} error={strategy.isError} onClick={() => void navigate({ to: '/strategy', search: { dialog: 'execute' } })} />
        <IncomeCard data={income.data} loading={income.isPending} />
        <RentCard overview={vgla.data} price={vglaPrice.data} loading={vgla.isPending || vglaPrice.isPending} error={vgla.isError || vglaPrice.isError} onClick={() => void navigate({ to: '/vgla', search: { dialog: undefined } })} />
      </div>
    </div>
  </section>
}

function NetWorthSummary({ points, loading }: { points: WealthPoint[]; loading: boolean }) {
  const first = points[0]
  const current = points.at(-1)
  const change = current && first ? current.trackedNetWorthCzk! - first.trackedNetWorthCzk! : null
  if (loading) return <div className="dashboard-chart-summary dashboard-chart-summary--loading" aria-label="Načítám změnu čistého jmění" />
  const tone = change !== null && change > 0 ? 'positive' : 'negative'
  return <div className={`dashboard-chart-summary ${change === null ? '' : tone}`}>
    <span className="dashboard-summary-icon">{change !== null && change > 0 ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}</span>
    <div><strong>{change === null ? '—' : `${change > 0 ? '+' : ''}${czk.format(change)}`}</strong><small>{change === null ? 'Pro výpočet změny chybí historie' : 'za poslední měsíc'}</small></div>
  </div>
}

function DashboardChart({ history, loading, fetching, error, onRetry }: { history: { date: string; value: number }[]; loading: boolean; fetching: boolean; error: boolean; onRetry: () => void }) {
  const gradientId = useId().replaceAll(':', '')
  const plotRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const points = history.filter((point) => Number.isFinite(point.value) && validDate(point.date))
  if (loading) return <div className="dashboard-chart-state dashboard-chart-skeleton" role="status" aria-label="Načítám historii" />
  if (error) return <div className="dashboard-chart-state error" role="alert"><RefreshCw size={18} /><strong>Historii se nepodařilo načíst</strong><button type="button" onClick={onRetry}>Zkusit znovu</button></div>
  if (points.length === 0) return <div className="dashboard-chart-state"><TrendingUp size={20} /><strong>Zatím není co zobrazit</strong><span>Graf se objeví po prvním záznamu čistého jmění.</span></div>

  const width = 960, height = 290, pad = { top: 18, right: 10, bottom: 18, left: 10 }
  const times = points.map((point) => Date.parse(`${point.date}T00:00:00Z`))
  const values = points.map((point) => point.value)
  const rawMin = Math.min(...values), rawMax = Math.max(...values)
  const rawRange = rawMax - rawMin
  const tickStep = niceTickStep(rawRange > 0 ? rawRange / 4 : Math.max(Math.abs(rawMax) * .1, 1000))
  let min = Math.floor(rawMin / tickStep) * tickStep
  let max = Math.ceil(rawMax / tickStep) * tickStep
  if (min === rawMin) min -= tickStep
  if (max === rawMax) max += tickStep
  const minTime = Math.min(...times), maxTime = Math.max(...times)
  const x = (date: string) => points.length === 1 ? width / 2 : pad.left + (Date.parse(`${date}T00:00:00Z`) - minTime) / Math.max(1, maxTime - minTime) * (width - pad.left - pad.right)
  const y = (value: number) => height - pad.bottom - (value - min) / (max - min) * (height - pad.top - pad.bottom)
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.date)} ${y(point.value)}`).join(' ')
  const areaPath = points.length > 1 ? `${linePath} L ${x(points.at(-1)!.date)} ${height - pad.bottom} L ${x(points[0].date)} ${height - pad.bottom} Z` : ''
  const tickValues = Array.from({ length: Math.round((max - min) / tickStep) + 1 }, (_, index) => max - index * tickStep)
  const dateTickCount = Math.min(5, points.length)
  const dateIndexes = [...new Set(Array.from({ length: dateTickCount }, (_, index) => Math.round(index * (points.length - 1) / Math.max(1, dateTickCount - 1))))]
  const change = points.at(-1)!.value - points[0].value
  const tone = change > 0 ? 'positive' : 'negative'
  const active = activeIndex === null ? null : points[activeIndex]

  const selectAtClientX = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const pointerTime = minTime + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * Math.max(1, maxTime - minTime)
    let closest = 0
    for (let index = 1; index < times.length; index++) if (Math.abs(times[index] - pointerTime) < Math.abs(times[closest] - pointerTime)) closest = index
    setActiveIndex(closest)
  }
  const selectFromMouse = (event: MouseEvent<HTMLDivElement>) => selectAtClientX(event.clientX)
  const selectFromPointer = (event: PointerEvent<HTMLDivElement>) => selectAtClientX(event.clientX)
  const selectFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') return setActiveIndex(0)
    if (event.key === 'End') return setActiveIndex(points.length - 1)
    setActiveIndex((index) => Math.max(0, Math.min(points.length - 1, (index ?? points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1))))
  }

  return <div className={`dashboard-chart-visual ${tone}${fetching ? ' fetching' : ''}`}>
    <div className="dashboard-chart-frame" role="group" tabIndex={0} aria-label="Graf čistého jmění. Hodnoty lze procházet šipkami doleva a doprava." onFocus={() => setActiveIndex((index) => index ?? points.length - 1)} onBlur={() => setActiveIndex(null)} onKeyDown={selectFromKeyboard}>
      <div className="dashboard-chart-grid">
        <div className="dashboard-y-axis" aria-hidden="true">{tickValues.map((tick) => <span key={tick}>{compactCzk.format(tick)}</span>)}</div>
        <div ref={plotRef} className="dashboard-chart-plot" onMouseMove={selectFromMouse} onMouseLeave={() => setActiveIndex(null)} onPointerDown={selectFromPointer}>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Vývoj čistého jmění">
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".2"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient>
            </defs>
            {tickValues.map((tick) => <line key={tick} className="dashboard-grid-line" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />)}
            {min < 0 && max > 0 && <line className="dashboard-zero-line" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />}
            {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
            {points.length > 1 && <path className="dashboard-history-line" d={linePath} />}
            {points.length === 1 && <circle className="dashboard-endpoint" cx={x(points[0].date)} cy={y(points[0].value)} r="4" />}
            {active && <><line className="dashboard-crosshair" x1={x(active.date)} x2={x(active.date)} y1={pad.top} y2={height - pad.bottom} /><circle className="dashboard-active-point" cx={x(active.date)} cy={y(active.value)} r="5" /></>}
          </svg>
          {active && <div className={`dashboard-chart-tooltip${activeIndex === 0 ? ' start' : activeIndex === points.length - 1 ? ' end' : ''}`} style={{ left: `${x(active.date) / width * 100}%`, top: `${y(active.value) / height * 100}%` }} aria-live="polite"><time>{chartDate.format(new Date(`${active.date}T12:00:00`))}</time><strong>{czk.format(active.value)}</strong></div>}
        </div>
      </div>
      <div className="dashboard-x-axis" aria-hidden="true">{dateIndexes.map((index) => <time className={index === 0 ? 'start' : index === points.length - 1 ? 'end' : undefined} style={{ left: `${x(points[index].date) / width * 100}%` }} key={points[index].date}>{chartDate.format(new Date(`${points[index].date}T12:00:00`))}</time>)}</div>
    </div>
    {fetching && <span className="dashboard-chart-refresh" role="status">Aktualizuji…</span>}
  </div>
}

function StrategyCard({ data, loading, error, onClick }: { data?: StrategyOverview; loading: boolean; error: boolean; onClick: () => void }) {
  const valid = data && [data.portfolioValueCzk, data.progressPercent, data.profitCzk, data.triggerCzk].every(Number.isFinite)
  const transfer = valid && data.recommendation === 'PRODAT'
  const recommendation = valid ? transfer ? 'PŘEVÉST' : 'DRŽET' : loading ? 'NAČÍTÁM' : 'NEDOSTUPNÉ'
  const progress = valid ? Math.min(100, Math.max(0, data.progressPercent)) : 0
  return <section className="dashboard-focus-card dashboard-strategy-card" aria-label="BTC strategie">
    <h3>BTC strategie</h3>
    <div className="dashboard-strategy-state">
      {transfer
        ? <button type="button" onClick={onClick}>PŘEVÉST</button>
        : <strong className={error ? 'negative' : undefined}>{recommendation}</strong>}
    </div>
    <div className="dashboard-strategy-progress">
      <strong>{valid ? `${Math.round(data.progressPercent)} %` : '—'}</strong>
      <div><span style={{ width: `${progress}%` }} /></div>
    </div>
  </section>
}

function IncomeCard({ data, loading }: { data?: IncomeOverview; loading: boolean }) {
  if (loading || !data?.settings || !Array.isArray(data.debts) || !Number.isFinite(data.settings.defaultCapitalCzk)) return <section className="dashboard-focus-card dashboard-income-card dashboard-income-loading" aria-label="Income plán" />
  return <IncomeCalculator key={data.settings.defaultCapitalCzk} data={data} />
}

function IncomeCalculator({ data }: { data: IncomeOverview }) {
  const [capital, setCapital] = useState(() => formatCzkInput(String(data.settings.defaultCapitalCzk || '')))
  const parsedCapital = parseCzkInput(capital)
  const amount = Number.isFinite(parsedCapital) && parsedCapital >= 0 ? parsedCapital : 0
  const hasDebts = data.debts.some((debt) => debt.balanceCzk > 0)
  const percentages = hasDebts
    ? { btc: data.settings.withDebtBtcPercent, debt: data.settings.withDebtDebtPercent, cash: data.settings.withDebtCashPercent }
    : { btc: data.settings.withoutDebtBtcPercent, debt: 0, cash: data.settings.withoutDebtCashPercent }
  const allocation = calculateIncomeAllocation(
    amount,
    data.scheduledDebtPaymentCzk ?? 0,
    data.settings.deferredDebtPaymentCzk ?? 0,
    percentages.btc,
    percentages.debt,
    percentages.cash,
    hasDebts,
    {
      totalDebtBalanceCzk: data.debts.reduce((sum, debt) => sum + Math.max(0, debt.balanceCzk), 0),
      withoutDebtBtcPercent: data.settings.withoutDebtBtcPercent,
      withoutDebtCashPercent: data.settings.withoutDebtCashPercent,
    },
  )
  const rows = [
    { label: 'Bitcoin', amount: allocation.btcAmount, icon: Bitcoin, tone: 'btc' },
    { label: 'Dluhy', amount: allocation.debtBudget + allocation.scheduledApplied, icon: Landmark, tone: 'debt' },
    { label: 'Spending účet', amount: allocation.cashAmount, icon: Wallet, tone: 'cash' },
  ].filter((row) => row.label !== 'Dluhy' || row.amount > .005)
  return <section className="dashboard-focus-card dashboard-income-card" aria-label="Income plán">
    <label className="dashboard-income-input"><span>Částka k rozdělení</span><div><input aria-label="Částka k rozdělení" inputMode="decimal" value={capital} onChange={(event) => setCapital(formatCzkInput(event.target.value))} /><b>Kč</b></div></label>
    <div className="dashboard-income-outputs">
      {rows.map((row) => {
        const Icon = row.icon
        const percent = amount > 0 ? row.amount / amount * 100 : 0
        return <output className={`dashboard-income-output ${row.tone}`} key={row.label}>
          <span className="dashboard-income-icon"><Icon size={16} /></span>
          <span>{row.label}</span>
          <strong>{czk.format(row.amount)}</strong>
          <b>{new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 }).format(percent)} %</b>
        </output>
      })}
    </div>
  </section>
}

function RentCard({ overview, price, loading, error, onClick }: { overview?: VglaOverview; price?: VglaPrice; loading: boolean; error: boolean; onClick: () => void }) {
  const totals = overview?.totals
  const valid = Boolean(totals && Number.isFinite(totals.shares) && Number.isFinite(totals.rentRatePercent) && Number.isFinite(price?.priceCzk))
  const value = valid ? totals!.shares * price!.priceCzk : null
  const annual = value === null ? null : value * totals!.rentRatePercent / 100
  const monthly = annual === null ? null : annual / 12
  return <button className="dashboard-focus-card dashboard-rent-card" type="button" aria-label="VGLA renta" onClick={onClick}>
    <div className="dashboard-card-primary"><span>VGLA renta</span><strong className="positive">{monthly === null ? '—' : czk.format(monthly)}</strong><small>{error ? 'Rentu se nepodařilo načíst' : loading ? 'Načítám portfolio…' : `Měsíčně · ${totals?.rentRatePercent ?? 0} % p.a. · ročně ${czk.format(annual ?? 0)}`}</small></div>
    <div className="dashboard-rent-footer"><div><span>Renta pool</span><strong>{czk.format(totals?.rentPoolCzk ?? 0)}</strong></div><div><span>Další dostupná renta</span><strong>{czk.format((totals?.rentPoolCzk ?? 0) + (monthly ?? 0))}</strong></div></div>
    {price?.isStale && <p>Tržní cena je dočasně zastaralá.</p>}
  </button>
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
}

function niceTickStep(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 1)))
  const normalized = value / magnitude
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return multiplier * magnitude
}

function normalizePoints(value: WealthPoint[] | undefined) {
  if (!Array.isArray(value)) return []
  return value.filter((point) => validDate(point.date) && Number.isFinite(point.trackedNetWorthCzk) && Number.isFinite(point.grossAssetsCzk)).sort((a, b) => a.date.localeCompare(b.date))
}
