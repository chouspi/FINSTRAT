import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CheckCircle2, ShieldCheck, X } from 'lucide-react'
import { antiforgeryToken, apiRequest } from '../lib/api'
import { createUuid } from '../lib/uuid'
import { notifyDataChanged } from '../lib/dataRefresh'
import './TaxesPage.css'

type TaxLot = { id: string; accountName: string; remainingQuantityBtc: number; unitPriceCzk: number | null; taxAcquiredAt: string; timeTestDate: string; isTimeTestSatisfied: boolean }
type TaxesOverview = { btcTaxPeriodYears: number; taxFreeBtc: number; taxableBtc: number; nextTimeTestDate: string | null; lots: TaxLot[]; deferredVwceCzk: number; recommendedTransferCzk: number; canDeferRecommendedTransfer: boolean }
const czk = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
const date = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })

export function TaxesPage() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState('')
  const key = useRef(createUuid())
  const overview = useQuery({ queryKey: ['taxes', 'overview'], queryFn: () => apiRequest<TaxesOverview>('/api/taxes/overview'), retry: false })
  const defer = useMutation({ mutationFn: async () => { const token = await antiforgeryToken(); return apiRequest('/api/taxes/deferred-vwce', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token, 'Idempotency-Key': key.current }, body: JSON.stringify({ note: note || null }) }) }, onSuccess: async () => { setConfirming(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ['taxes'] }), queryClient.invalidateQueries({ queryKey: ['strategy'] }), queryClient.invalidateQueries({ queryKey: ['income-plan'] })]); notifyDataChanged() } })
  if (overview.isPending) return <section className="taxes-page"><div className="taxes-loading" /></section>
  if (overview.isError) return <section className="taxes-page taxes-state"><ShieldCheck size={28} /><h2>Daňový přehled se nepodařilo načíst</h2><button type="button" onClick={() => overview.refetch()}>Zkusit znovu</button></section>
  const data = overview.data
  return <section className="taxes-page">
    <div className="taxes-summary"><TaxMetric label="Osvobozeno" value={`${data.taxFreeBtc.toFixed(6)} BTC`} tone="positive" /><TaxMetric label="Čeká na osvobození" value={`${data.taxableBtc.toFixed(6)} BTC`} /><TaxMetric label="Nejbližší osvobození" value={data.nextTimeTestDate ? date.format(new Date(`${data.nextTimeTestDate}T12:00:00`)) : '—'} /><TaxMetric label="VWCE místo BTC pool" value={czk.format(data.deferredVwceCzk)} tone={data.deferredVwceCzk > 0 ? 'vwce' : undefined} /></div>
    {data.canDeferRecommendedTransfer && <div className="taxes-defer-banner"><div><CalendarClock size={19} /><span><strong>BTC pro doporučený prodej ještě nesplňuje časový test</strong><small>Můžete předstírat realizaci {czk.format(data.recommendedTransferCzk)}. BTC zůstane beze změny, checkpoint se posune a budoucí BTC alokace příjmu půjde do VWCE.</small></span></div><button type="button" onClick={() => setConfirming(true)}>Odložit {czk.format(data.recommendedTransferCzk)}</button></div>}
    <div className="taxes-content" style={{ display: 'block' }}>
      <section className="taxes-panel"><header><span>KALENDÁŘ OSVOBOZENÍ</span><strong>{data.btcTaxPeriodYears} roky</strong></header>{data.lots.length === 0 ? <p>Nejsou evidované žádné držené BTC loty.</p> : <div className="tax-lots">{data.lots.map((lot) => <div key={lot.id}><span className={lot.isTimeTestSatisfied ? 'free' : ''}>{lot.isTimeTestSatisfied ? <CheckCircle2 size={15} /> : <CalendarClock size={15} />}</span><div><strong>{lot.accountName}</strong><small>Nákup {date.format(new Date(`${lot.taxAcquiredAt}T12:00:00`))}</small></div><b>{lot.remainingQuantityBtc.toFixed(8)} BTC</b><time>{lot.isTimeTestSatisfied ? 'Osvobozeno' : date.format(new Date(`${lot.timeTestDate}T12:00:00`))}</time></div>)}</div>}</section>
    </div>
    {confirming && <div className="dialog-backdrop" role="presentation"><section className="taxes-confirm" role="dialog" aria-modal="true" aria-label="Odložit realizaci do VWCE"><button type="button" aria-label="Zavřít" onClick={() => setConfirming(false)}><X size={17} /></button><span>VWCE MÍSTO BTC</span><h2>Odložit {czk.format(data.recommendedTransferCzk)}?</h2><p>BTC se neprodá. Checkpoint se upraví, jako by realizace proběhla, a stejná částka se uloží do poolu pro budoucí nákupy VWCE.</p><label>Poznámka<input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>{defer.error && <p className="form-error" role="alert">{defer.error.message}</p>}<div><button type="button" onClick={() => setConfirming(false)}>Zrušit</button><button className="primary" type="button" disabled={defer.isPending} onClick={() => defer.mutate()}>{defer.isPending ? 'Odkládám…' : 'Potvrdit odložení'}</button></div></section></div>}
  </section>
}
function TaxMetric({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div><span>{label}</span><strong className={tone}>{value}</strong></div> }
