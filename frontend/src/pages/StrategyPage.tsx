import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowRight, Bitcoin, CircleGauge, Flag, Landmark, Target, TrendingUp, X } from 'lucide-react'
import { apiRequest } from '../lib/api'
import type { StrategyOverview } from '../lib/strategy'
import './StrategyPage.css'

const czk = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })

export function StrategyPage() {
  const navigate = useNavigate()
  const { dialog } = useSearch({ from: '/strategy' })
  const overview = useQuery({ queryKey: ['strategy', 'overview'], queryFn: () => apiRequest<StrategyOverview>('/api/strategy/overview'), retry: false })
  if (overview.isPending) return <section className="strategy-page"><div className="strategy-loading" /></section>
  if (overview.isError) return <section className="strategy-page strategy-state"><CircleGauge size={28} /><h2>Strategii se nepodařilo načíst</h2><button type="button" onClick={() => overview.refetch()}>Zkusit znovu</button></section>

  const data = overview.data
  const triggered = data.recommendation === 'PRODAT'
  const progress = Math.min(100, Math.max(0, data.progressPercent))
  const checkpoint = data.checkpointValueCzk ?? data.portfolioValueCzk
  const statusTitle = triggered ? czk.format(data.recommendedTransferCzk) : 'Držet pozici'
  const statusCopy = triggered
    ? 'Profit překročil nastavený trigger. Realizujte pouze doporučenou část a zbytek BTC ponechte v portfoliu.'
    : `Do další realizace zbývá ${czk.format(data.remainingCzk)} zisku nad checkpoint.`
  const closeExecution = () => void navigate({ to: '/strategy', search: { dialog: undefined }, replace: true })

  return <section className={`strategy-page strategy-page--${triggered ? 'sell' : 'hold'}`}>
    <div className="strategy-content">
      <section className="strategy-panel strategy-summary" aria-labelledby="strategy-status-title">
        <div className="strategy-primary">
          <div className="strategy-primary-top">
            <span className="strategy-primary-icon" aria-hidden="true">{triggered ? <TrendingUp size={20} /> : <CircleGauge size={20} />}</span>
            <span className="strategy-status-badge">{data.recommendation}</span>
          </div>
          <div>
            <p>{triggered ? 'FINÁLNÍ SUMA K PŘEVODU' : 'AKTIVNÍ CHECKPOINT'}</p>
            <h1 id="strategy-status-title">{statusTitle}</h1>
            <span>{statusCopy}</span>
            {triggered && <button className="strategy-execute" type="button" onClick={() => void navigate({ to: '/strategy', search: { dialog: 'execute' } })}>Provést převod</button>}
          </div>
        </div>
        <div className="strategy-summary-stats">
          <StrategyMetric icon={Bitcoin} label="BTC portfolio" value={czk.format(data.portfolioValueCzk)} sub={`${data.btcQuantity.toFixed(6)} BTC`} />
          <StrategyMetric icon={Flag} label="Checkpoint" value={czk.format(checkpoint)} sub="referenční hodnota" />
          <StrategyMetric icon={TrendingUp} label="Zisk od checkpointu" value={czk.format(data.profitCzk)} tone={data.profitCzk >= 0 ? 'positive' : 'negative'} sub={`${data.profitPercent >= 0 ? '+' : ''}${data.profitPercent.toFixed(2)} %`} />
        </div>
      </section>

      <section className="strategy-panel strategy-trigger" aria-labelledby="strategy-trigger-title">
        <header className="strategy-panel-heading">
          <div className="strategy-heading-copy">
            <span className="strategy-section-icon" aria-hidden="true"><Target size={18} /></span>
            <div><p>POSTUP K TRIGGERU</p><h2 id="strategy-trigger-title">{triggered ? 'Trigger byl překročen' : `${Math.round(progress)} % cíle`}</h2><span>Realizace se řídí ziskem nad aktivním checkpointem.</span></div>
          </div>
          <div className={`strategy-trigger-value${triggered ? ' positive' : ''}`}><span>TRIGGER</span><strong>{czk.format(data.triggerCzk)}</strong></div>
        </header>
        <div className="strategy-progress-body">
          <div className="strategy-progress-track" role="progressbar" aria-label="Postup k triggeru" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${progress}%` }} /></div>
          <div className="strategy-progress-labels"><span>Zisk <strong className={data.profitCzk >= 0 ? 'positive' : 'negative'}>{czk.format(data.profitCzk)}</strong></span><span>{triggered ? 'Trigger překročen' : <>Zbývá <strong>{czk.format(data.remainingCzk)}</strong></>}</span></div>
        </div>
      </section>

      <section className="strategy-panel strategy-rules" aria-labelledby="strategy-rules-title">
        <header className="strategy-panel-heading">
          <div className="strategy-heading-copy">
            <span className="strategy-section-icon" aria-hidden="true"><Landmark size={18} /></span>
            <div><p>PRAVIDLA REALIZACE</p><h2 id="strategy-rules-title">Od zisku k převodu</h2><span>Strategie chrání základ portfolia a realizuje jen definovanou část růstu.</span></div>
          </div>
        </header>
        <div className="strategy-rule-flow">
          <RuleStep number="01" label="Checkpoint" value={czk.format(checkpoint)} note="Základ zůstává v BTC" />
          <ArrowRight className="strategy-rule-arrow" size={17} aria-hidden="true" />
          <RuleStep number="02" label="Profit trigger" value={`${data.settings.checkpointTriggerPercent} %`} note={`Minimálně ${czk.format(data.settings.checkpointTriggerFloorCzk)}`} />
          <ArrowRight className="strategy-rule-arrow" size={17} aria-hidden="true" />
          <RuleStep number="03" label="Převod do VGLA" value={czk.format(data.settings.realizationStepTransferCzk)} note={`Za každých ${czk.format(data.settings.realizationStepProfitCzk)} zisku`} tone="green" />
        </div>
      </section>
    </div>
    {triggered && dialog === 'execute' && <ExecutionDialog data={data} onClose={closeExecution} onContinue={() => void navigate({ to: '/bitcoin', search: { dialog: undefined } })} />}
  </section>
}

type Icon = typeof Bitcoin

function StrategyMetric({ icon: Icon, label, value, sub, tone }: { icon: Icon; label: string; value: string; sub: string; tone?: string }) {
  return <div className="strategy-stat"><span className="strategy-stat-icon" aria-hidden="true"><Icon size={16} /></span><div><span>{label}</span><strong className={tone}>{value}</strong><small>{sub}</small></div></div>
}

function RuleStep({ number, label, value, note, tone }: { number: string; label: string; value: string; note: string; tone?: 'green' }) {
  return <article className={`strategy-rule-step${tone ? ` strategy-rule-step--${tone}` : ''}`}><span>{number}</span><div><p>{label}</p><strong>{value}</strong><small>{note}</small></div></article>
}

function ExecutionDialog({ data, onClose, onContinue }: { data: StrategyOverview; onClose: () => void; onContinue: () => void }) {
  const quantity = data.btcPriceCzk > 0 ? data.recommendedTransferCzk / data.btcPriceCzk : 0
  return <div className="dialog-backdrop strategy-execution-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="strategy-execution-dialog" role="dialog" aria-modal="true" aria-labelledby="strategy-execution-title">
      <button className="strategy-execution-close" type="button" aria-label="Zavřít realizaci" onClick={onClose}><X size={18} /></button>
      <span>REALIZACE STRATEGIE</span>
      <h2 id="strategy-execution-title">Převést {czk.format(data.recommendedTransferCzk)}</h2>
      <p>Prodejte odpovídající část BTC a výnos převeďte do VGLA. Po provedení obchodu zapište prodej v BTC účtech.</p>
      <div className="strategy-execution-summary"><span>Odhad BTC k prodeji<strong>{quantity.toFixed(8)} BTC</strong></span><span>Použitá cena BTC<strong>{czk.format(data.btcPriceCzk)}</strong></span></div>
      <div className="strategy-execution-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="primary" type="button" onClick={onContinue}>Pokračovat na BTC účty <ArrowRight size={15} /></button></div>
    </section>
  </div>
}
