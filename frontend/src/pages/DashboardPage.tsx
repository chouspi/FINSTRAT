import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Banknote, ChevronRight } from 'lucide-react'
import { apiRequest } from '../lib/api'
import type { StrategyOverview } from '../lib/strategy'
import './DashboardPage.css'

type ScheduledPayment = { id: string; amountCzk: number; isDue: boolean }
type DebtOverview = { scheduledPayments?: ScheduledPayment[] }
type WealthPoint = {
  date: string
  btcValueCzk: number
  vwceValueCzk: number
  consumerDebtCzk: number
  trackedNetWorthCzk: number
}
type WealthHistory = { current: WealthPoint | null; points: WealthPoint[] }
type IncomeOverview = {
  settings: {
    defaultCapitalCzk: number
    withoutDebtBtcPercent: number
    withoutDebtCashPercent: number
    withDebtBtcPercent: number
    withDebtDebtPercent: number
    withDebtCashPercent: number
  }
  debts: { id: string; name: string; balanceCzk: number }[]
  scheduledDebtPaymentCzk?: number
}
type BitcoinOverview = {
  totals: { quantityBtc: number; costBasisCzk: number; accountCount: number; costBasisComplete: boolean }
  accounts: { id: string; name: string; quantityBtc: number; costBasisCzk: number }[]
}
type BtcPrice = { priceCzk: number }
type VwceOverview = {
  totals: { shares: number; costBasisCzk: number; accountCount: number; costBasisComplete: boolean; rentRatePercent: number }
}
type VwcePrice = { priceCzk: number }

const czk = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })

export function DashboardPage() {
  const navigate = useNavigate()
  const overview = useQuery({ queryKey: ['debts', 'overview'], queryFn: () => apiRequest<DebtOverview>('/api/debts/overview'), retry: false })
  const wealth = useQuery({ queryKey: ['wealth', 'history', 30], queryFn: () => apiRequest<WealthHistory>('/api/wealth/history?days=30'), retry: false })
  const income = useQuery({ queryKey: ['income-plan', 'overview'], queryFn: () => apiRequest<IncomeOverview>('/api/income-plan/overview'), retry: false })
  const strategy = useQuery({ queryKey: ['strategy', 'overview'], queryFn: () => apiRequest<StrategyOverview>('/api/strategy/overview'), retry: false })
  const bitcoin = useQuery({ queryKey: ['bitcoin', 'overview'], queryFn: () => apiRequest<BitcoinOverview>('/api/bitcoin/overview'), retry: false })
  const btcPrice = useQuery({ queryKey: ['market-data', 'btc-price'], queryFn: () => apiRequest<BtcPrice>('/api/market-data/btc-price'), retry: false })
  const vwce = useQuery({ queryKey: ['vwce', 'overview'], queryFn: () => apiRequest<VwceOverview>('/api/vwce/overview'), retry: false })
  const vwcePrice = useQuery({ queryKey: ['market-data', 'vwce-price'], queryFn: () => apiRequest<VwcePrice>('/api/market-data/vwce-price'), retry: false })
  const due = (overview.data?.scheduledPayments ?? []).filter((payment) => payment.isDue)
  const amount = due.reduce((sum, payment) => sum + payment.amountCzk, 0)
  const points = Array.isArray(wealth.data?.points) ? wealth.data.points : []
  const current = wealth.data?.current && Number.isFinite(wealth.data.current.trackedNetWorthCzk)
    ? wealth.data.current
    : points.at(-1) ?? null
  return <section className="dashboard-page">
    <button className="dashboard-net-worth" type="button" aria-label="Otevřít tab Čisté jmění" onClick={() => void navigate({ to: '/wealth', search: { tab: 'net' } })}>
      <div className="dashboard-net-worth-copy">
        <div className="dashboard-widget-title"><span>Čisté jmění</span><ChevronRight size={13} /></div>
        <strong className={(current?.trackedNetWorthCzk ?? 0) < 0 ? 'negative' : undefined}>{current ? czk.format(current.trackedNetWorthCzk) : '—'}</strong>
        <p>Sledovaná aktiva − dluhy, bez hotovosti</p>
        <div className="dashboard-net-worth-breakdown">
          <DashboardMetric label="BTC" value={current?.btcValueCzk} tone="btc" />
          <DashboardMetric label="VWCE" value={current?.vwceValueCzk} />
          {(current?.consumerDebtCzk ?? 0) > 0 && <DashboardMetric label="Dluhy" value={-(current?.consumerDebtCzk ?? 0)} tone="debt" />}
        </div>
      </div>
      <div className="dashboard-net-worth-chart"><DashboardNetWorthChart points={points} /></div>
    </button>
    <div className="dashboard-card-grid">
      <IncomePlanCard data={income.data} onClick={() => void navigate({ to: '/income-plan', search: { dialog: undefined } })} />
      <StrategyCard data={strategy.data} onClick={() => void navigate({ to: '/strategy' })} />
      <BitcoinAccountsCard data={bitcoin.data} priceCzk={btcPrice.data?.priceCzk} onClick={() => void navigate({ to: '/bitcoin', search: { dialog: undefined } })} />
      <VwcePortfolioCard data={vwce.data} priceCzk={vwcePrice.data?.priceCzk} onClick={() => void navigate({ to: '/vwce', search: { dialog: undefined } })} />
    </div>
    {due.length > 0 && <div className="dashboard-due-backdrop"><section className="dashboard-due-dialog" role="dialog" aria-modal="true" aria-labelledby="dashboard-due-title"><div><Banknote size={19} /></div><span>PLÁNOVANÉ SPLÁTKY</span><h2 id="dashboard-due-title">Je čas potvrdit splátky</h2><p>{due.length === 1 ? 'Jedna plánovaná splátka dosáhla data splatnosti.' : `${due.length} plánované splátky dosáhly data splatnosti.`} Celkem {czk.format(amount)}.</p><button type="button" onClick={() => void navigate({ to: '/debts', search: { dialog: undefined } })}>OK, přejít na Dluhy</button></section></div>}
  </section>
}

function BitcoinAccountsCard({ data, priceCzk, onClick }: { data?: BitcoinOverview; priceCzk?: number; onClick: () => void }) {
  const price = typeof priceCzk === 'number' && Number.isFinite(priceCzk) && priceCzk > 0 ? priceCzk : null
  const costBasis = typeof data?.totals?.costBasisCzk === 'number' ? data.totals.costBasisCzk : null
  const quantity = typeof data?.totals?.quantityBtc === 'number' ? data.totals.quantityBtc : null
  const value = price !== null && quantity !== null ? quantity * price : null
  const gain = value !== null && costBasis !== null ? value - costBasis : null
  return <button className="dashboard-card dashboard-asset-card dashboard-btc-accounts-card" type="button" aria-label="Otevřít BTC účty" onClick={onClick}>
    <DashboardCardHeader title="BTC Účty" />
    <div className="dashboard-asset-main"><span>Hodnota BTC</span><strong>{value === null ? '—' : czk.format(value)}</strong><small>{quantity === null ? 'Načítám…' : `${quantity.toFixed(6)} BTC`}</small></div>
    <div className="dashboard-asset-footer"><DashboardSmallMetric label="Investováno" value={costBasis === null ? '—' : czk.format(costBasis)} /><DashboardSmallMetric label="Zisk / Ztráta" value={gain === null ? '—' : czk.format(gain)} tone={gain === null ? undefined : gain >= 0 ? 'positive' : 'negative'} /></div>
  </button>
}

function VwcePortfolioCard({ data, priceCzk, onClick }: { data?: VwceOverview; priceCzk?: number; onClick: () => void }) {
  const totals = data?.totals
  const price = typeof priceCzk === 'number' && Number.isFinite(priceCzk) && priceCzk > 0 ? priceCzk : null
  const shares = typeof totals?.shares === 'number' ? totals.shares : null
  const costBasis = typeof totals?.costBasisCzk === 'number' ? totals.costBasisCzk : null
  const value = price !== null && shares !== null ? shares * price : null
  const gain = value !== null && costBasis !== null ? value - costBasis : null
  const annualRent = value !== null && typeof totals?.rentRatePercent === 'number' ? value * totals.rentRatePercent / 100 : null
  return <button className="dashboard-card dashboard-asset-card dashboard-vwce-card" type="button" aria-label="Otevřít VWCE portfolio" onClick={onClick}>
    <DashboardCardHeader title="VWCE Portfolio" />
    <div className="dashboard-asset-main"><span>Hodnota VWCE</span><strong>{value === null ? '—' : czk.format(value)}</strong><small>{shares === null ? 'Načítám…' : `${shares.toLocaleString('cs-CZ', { maximumFractionDigits: 4 })} ks`}</small></div>
    <div className="dashboard-asset-footer"><DashboardSmallMetric label="Zisk / Ztráta" value={gain === null ? '—' : czk.format(gain)} tone={gain === null ? undefined : gain >= 0 ? 'positive' : 'negative'} /><DashboardSmallMetric label="Renta / měs." value={annualRent === null ? '—' : czk.format(annualRent / 12)} tone={annualRent && annualRent > 0 ? 'positive' : undefined} /></div>
  </button>
}

function StrategyCard({ data, onClick }: { data?: StrategyOverview; onClick: () => void }) {
  const valid = data && typeof data.portfolioValueCzk === 'number' && typeof data.progressPercent === 'number'
  const recommendation = valid ? data.recommendation : 'NAČÍTÁM'
  const tone = recommendation === 'PRODAT' ? 'sell' : recommendation === 'DRŽET' ? 'hold' : 'accumulate'
  return <button className="dashboard-card dashboard-strategy-card" type="button" aria-label="Otevřít BTC strategii" onClick={onClick}>
    <DashboardCardHeader title="BTC Strategie" />
    <div className="dashboard-strategy-main"><span>Hodnota BTC portfolia</span><strong>{valid ? czk.format(data.portfolioValueCzk) : '—'}</strong><small>{valid ? `${data.btcQuantity.toFixed(6)} BTC` : 'Načítám strategii…'}</small></div>
    <div className="dashboard-strategy-status"><div><span>{data?.checkpointActive ? 'Zisk od checkpointu' : 'Do aktivace zbývá'}</span><strong className={data?.checkpointActive && data.profitCzk < 0 ? 'negative' : undefined}>{valid ? czk.format(data.checkpointActive ? data.profitCzk : data.remainingCzk) : '—'}</strong></div><b className={tone}>{recommendation}</b></div>
    <div className="dashboard-strategy-progress"><div><span style={{ width: `${valid ? Math.min(100, Math.max(0, data.progressPercent)) : 0}%` }} /></div><small>{data?.checkpointActive ? `Trigger ${czk.format(data.triggerCzk)}` : `Aktivace ${czk.format(data?.settings?.checkpointActivationThresholdCzk ?? 0)}`}</small><strong>{valid ? `${Math.round(data.progressPercent)} %` : '—'}</strong></div>
    {valid && data.recommendedTransferCzk > 0 && <p>Přesunout do VWCE: <strong>{czk.format(data.recommendedTransferCzk)}</strong></p>}
  </button>
}

function IncomePlanCard({ data, onClick }: { data?: IncomeOverview; onClick: () => void }) {
  const debts = Array.isArray(data?.debts) ? data.debts : []
  const settings = data?.settings
  const hasDebts = debts.length > 0
  const allocations = hasDebts
    ? [
        { label: 'BTC', percent: settings?.withDebtBtcPercent ?? 0, tone: 'btc' },
        { label: 'Dluhy', percent: settings?.withDebtDebtPercent ?? 0, tone: 'debt' },
        { label: 'Cash', percent: settings?.withDebtCashPercent ?? 0, tone: 'cash' },
      ]
    : [
        { label: 'BTC', percent: settings?.withoutDebtBtcPercent ?? 0, tone: 'btc' },
        { label: 'Cash', percent: settings?.withoutDebtCashPercent ?? 0, tone: 'cash' },
      ]
  const totalDebt = debts.reduce((sum, debt) => sum + debt.balanceCzk, 0)
  return <button className="dashboard-card dashboard-income-card" type="button" aria-label="Otevřít Income plán" onClick={onClick}>
    <DashboardCardHeader title="Income plán" />
    <div className="dashboard-income-allocations">{allocations.map((allocation) => <div className={allocation.tone} key={allocation.label}><span>{allocation.label}</span><strong>{allocation.percent} %</strong></div>)}</div>
    {hasDebts ? <div className="dashboard-income-debts"><span>{debts.length} {debts.length === 1 ? 'dluh' : debts.length < 5 ? 'dluhy' : 'dluhů'}</span><div><span>Celkem</span><strong>{czk.format(totalDebt)}</strong></div>{(data?.scheduledDebtPaymentCzk ?? 0) > 0 && <small>Plánované splátky: {czk.format(data?.scheduledDebtPaymentCzk ?? 0)}</small>}</div> : <div className="dashboard-income-free"><span>{settings ? 'Žádné dluhy · režim bez dluhů' : 'Načítám Income plán…'}</span>{settings && <strong>Výchozí kapitál {czk.format(settings.defaultCapitalCzk)}</strong>}</div>}
  </button>
}

function DashboardCardHeader({ title }: { title: string }) {
  return <div className="dashboard-card-header"><span>{title}</span><ChevronRight size={13} /></div>
}

function DashboardSmallMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div><span>{label}</span><strong className={tone}>{value}</strong></div>
}

function DashboardMetric({ label, value, tone }: { label: string; value?: number; tone?: string }) {
  return <div><span>{label}</span><strong className={tone}>{value === undefined ? '—' : czk.format(value)}</strong></div>
}

function DashboardNetWorthChart({ points }: { points: WealthPoint[] }) {
  if (points.length < 2) return <div className="dashboard-chart-empty">Pro 30denní graf zatím není dost záznamů.</div>
  const width = 600
  const height = 120
  const padding = 8
  const values = points.map((point) => point.trackedNetWorthCzk)
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const spread = Math.max(rawMax - rawMin, Math.abs(rawMax) * .05, 1)
  const min = rawMin - spread * .1
  const max = rawMax + spread * .1
  const x = (index: number) => padding + index / (points.length - 1) * (width - padding * 2)
  const y = (value: number) => height - padding - (value - min) / (max - min) * (height - padding * 2)
  const line = points.map((point, index) => `${x(index)},${y(point.trackedNetWorthCzk)}`).join(' ')
  const area = `${padding},${height - padding} ${line} ${width - padding},${height - padding}`
  const rising = values.at(-1)! >= values[0]
  return <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Vývoj čistého jmění za 30 dní">
    <defs><linearGradient id="dashboard-net-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className={rising ? 'up' : 'down'} stopOpacity=".18" /><stop offset="1" className={rising ? 'up' : 'down'} stopOpacity="0" /></linearGradient></defs>
    <polygon points={area} fill="url(#dashboard-net-fill)" />
    <polyline className={rising ? 'up' : 'down'} points={line} />
  </svg>
}
