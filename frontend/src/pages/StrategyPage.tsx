import { useQuery } from '@tanstack/react-query'
import { CircleGauge, TrendingUp } from 'lucide-react'
import { apiRequest } from '../lib/api'
import type { StrategyOverview } from '../lib/strategy'
import './StrategyPage.css'

const czk = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })

export function StrategyPage() {
  const overview = useQuery({ queryKey: ['strategy', 'overview'], queryFn: () => apiRequest<StrategyOverview>('/api/strategy/overview'), retry: false })
  if (overview.isPending) return <section className="strategy-page"><div className="strategy-loading" /></section>
  if (overview.isError) return <section className="strategy-page strategy-state"><CircleGauge size={28} /><h2>Strategii se nepodařilo načíst</h2><button type="button" onClick={() => overview.refetch()}>Zkusit znovu</button></section>
  const data = overview.data
  const triggered = data.recommendation === 'PRODAT'
  return <section className="strategy-page">
    <div className={`strategy-banner strategy-banner--${data.recommendation.toLowerCase()}`}>
      <div><span>{data.checkpointActive ? triggered ? 'TRIGGER DOSAŽEN' : 'AKTIVNÍ CHECKPOINT' : 'FÁZE AKUMULACE'}</span><h2>{data.checkpointActive ? triggered ? `Realizovat ${czk.format(data.recommendedTransferCzk)} do VWCE` : 'Držet a pokračovat podle plánu' : 'Budování prvního checkpointu'}</h2><p>{data.checkpointActive ? `Profit je ${czk.format(data.profitCzk)} vůči checkpointu ${czk.format(data.checkpointValueCzk ?? 0)}.` : data.settings.checkpointAuto ? 'Po dosažení nastaveného cíle se checkpoint aktivuje automaticky.' : 'Automatická aktivace checkpointu je vypnutá.'}</p></div><strong>{data.recommendation}</strong>
    </div>

    <div className="strategy-metrics">
      <StrategyMetric label="BTC Portfolio" value={czk.format(data.portfolioValueCzk)} sub={`${data.btcQuantity.toFixed(6)} BTC`} />
      <StrategyMetric label={data.checkpointActive ? 'Checkpoint' : 'Aktuální cena BTC'} value={czk.format(data.checkpointActive ? data.checkpointValueCzk ?? 0 : data.btcPriceCzk)} sub={data.checkpointActive ? 'referenční hodnota' : 'tržní cena za 1 BTC'} />
      <StrategyMetric label={data.checkpointActive ? 'Profit' : 'Cíl aktivace'} value={czk.format(data.checkpointActive ? data.profitCzk : data.settings.checkpointActivationThresholdCzk)} tone={data.checkpointActive ? data.profitCzk >= 0 ? 'positive' : 'negative' : undefined} sub={data.checkpointActive ? `${data.profitPercent >= 0 ? '+' : ''}${data.profitPercent.toFixed(2)} % checkpointu` : data.settings.checkpointAuto ? 'automatická aktivace' : 'automatika vypnuta'} />
      <StrategyMetric label={data.checkpointActive ? 'Trigger' : 'Zbývá'} value={czk.format(data.checkpointActive ? data.triggerCzk : data.remainingCzk)} sub={data.checkpointActive ? `max. práh nebo ${data.settings.checkpointTriggerPercent} % checkpointu` : 'do prvního checkpointu'} />
    </div>

    <div className="strategy-content">
      <section className="strategy-panel strategy-progress-panel">
        <header><div><span>{data.checkpointActive ? 'POSTUP K TRIGGERU' : 'AKUMULACE'}</span><h3>{triggered ? 'Dosaženo' : `${Math.round(data.progressPercent)} %`}</h3></div><TrendingUp size={19} /></header>
        <div className="strategy-progress"><span style={{ width: `${Math.min(100, Math.max(0, data.progressPercent))}%` }} /></div>
        <div className="strategy-progress-labels"><span>{data.checkpointActive ? `Profit ${czk.format(data.profitCzk)}` : `Portfolio ${czk.format(data.portfolioValueCzk)}`}</span><strong>{triggered ? 'Trigger překročen' : `Zbývá ${czk.format(data.remainingCzk)}`}</strong></div>
      </section>

    </div>
  </section>
}

function StrategyMetric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) { return <div><span>{label}</span><strong className={tone}>{value}</strong>{sub && <small>{sub}</small>}</div> }
