import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Check, LockKeyhole, Save, Settings, UnlockKeyhole } from 'lucide-react'
import { antiforgeryToken, apiRequest } from '../lib/api'
import type { StrategyOverview, StrategySettings } from '../lib/strategy'
import './SettingsPage.css'
import './SettingsStrategy.css'

type IncomeSettings = {
  defaultCapitalCzk: number
  withoutDebtBtcPercent: number
  withoutDebtCashPercent: number
  withDebtBtcPercent: number
  withDebtDebtPercent: number
  withDebtCashPercent: number
  cashAccountIban: string | null
  coinmateIban: string | null
  coinmateVariableSymbol: string | null
  coinmateRecipientMessage: string | null
}
type IncomeOverview = { settings: IncomeSettings }
type IncomePercentKey = Exclude<keyof IncomeSettings, 'defaultCapitalCzk' | 'cashAccountIban' | 'coinmateIban' | 'coinmateVariableSymbol' | 'coinmateRecipientMessage'>

export function SettingsPage() {
  const { tab } = useSearch({ from: '/settings' })
  const navigate = useNavigate({ from: '/settings' })
  const activeTab = tab === 'strategy' ? 'strategy' : 'income'
  return <section className="settings-page">
    <div className="settings-tabs" role="tablist" aria-label="Sekce nastavení">
      <button role="tab" aria-selected={activeTab === 'income'} type="button" onClick={() => void navigate({ search: { tab: undefined }, replace: true })}>Income plán</button>
      <button role="tab" aria-selected={activeTab === 'strategy'} type="button" onClick={() => void navigate({ search: { tab: 'strategy' }, replace: true })}>BTC Strategie</button>
    </div>
    {activeTab === 'strategy' ? <StrategySettingsPane /> : <IncomeSettingsPane />}
  </section>
}

function IncomeSettingsPane() {
  const overview = useQuery({ queryKey: ['income-plan', 'overview'], queryFn: () => apiRequest<IncomeOverview>('/api/income-plan/overview'), retry: false })
  if (overview.isPending) return <div className="settings-loading" />
  if (overview.isError) return <SettingsState onRetry={() => overview.refetch()} />
  return <IncomeAllocationSettings key={JSON.stringify(overview.data.settings)} initial={overview.data.settings} />
}

function IncomeAllocationSettings({ initial }: { initial: IncomeSettings }) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState(initial)
  const [coinmateUnlocked, setCoinmateUnlocked] = useState(false)
  const [unlockWarningOpen, setUnlockWarningOpen] = useState(false)
  const valid = settings.withoutDebtBtcPercent + settings.withoutDebtCashPercent === 100
    && settings.withDebtBtcPercent + settings.withDebtDebtPercent + settings.withDebtCashPercent === 100
  const save = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      return apiRequest<IncomeSettings>('/api/income-plan/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({ ...settings, defaultCapitalCzk: String(settings.defaultCapitalCzk) }),
      })
    },
    onSuccess: async (saved) => {
      setSettings(saved)
      setCoinmateUnlocked(false)
      await queryClient.invalidateQueries({ queryKey: ['income-plan'] })
    },
  })

  return <div className="settings-pane">
    <SettingsHeading eyebrow="INCOME PLÁN" title="Pravidla rozdělení příjmu" description="Procenta se automaticky použijí podle toho, zda máte aktivní spotřebitelský dluh." valid={valid} save={save} />
    <div className="settings-profiles">
      <AllocationProfile title="Bez spotřebitelských dluhů" fields={[["BTC", 'withoutDebtBtcPercent'], ["Cash", 'withoutDebtCashPercent']]} settings={settings} onChange={setSettings} />
      <AllocationProfile title="S aktivními dluhy" fields={[["BTC", 'withDebtBtcPercent'], ["Dluhy", 'withDebtDebtPercent'], ["Cash", 'withDebtCashPercent']]} settings={settings} onChange={setSettings} />
      <section className="settings-cash-account">
        <div><strong>Cash účet (IBAN)</strong><small>Použije se pro QR převod do Cash obálky. Pole může zůstat prázdné.</small></div>
        <input aria-label="Cash účet (IBAN)" type="text" autoComplete="off" placeholder="CZ00 0000 0000 0000 0000 0000" value={settings.cashAccountIban ?? ''} onChange={(event) => setSettings({ ...settings, cashAccountIban: event.target.value || null })} />
      </section>
      <section className={`settings-coinmate-payment${coinmateUnlocked ? ' unlocked' : ' locked'}`}>
        <div className="settings-coinmate-heading">
          <span><strong>Coinmate platební údaje</strong><small>Použijí se výhradně pro QR v režimu zpracování příjmu.</small></span>
          <button type="button" aria-label={coinmateUnlocked ? 'Coinmate platební údaje jsou odemčené' : 'Odemknout Coinmate platební údaje'} disabled={coinmateUnlocked} onClick={() => setUnlockWarningOpen(true)}>{coinmateUnlocked ? <UnlockKeyhole size={15} /> : <LockKeyhole size={15} />}</button>
        </div>
        <label><span>IBAN / účet</span><input disabled={!coinmateUnlocked} aria-label="Coinmate IBAN / účet" type="text" autoComplete="off" placeholder="CZ00 0000 0000 0000 0000 0000" value={settings.coinmateIban ?? ''} onChange={(event) => setSettings({ ...settings, coinmateIban: event.target.value || null })} /></label>
        <label><span>Variabilní symbol</span><input disabled={!coinmateUnlocked} aria-label="Coinmate variabilní symbol" type="text" inputMode="numeric" autoComplete="off" value={settings.coinmateVariableSymbol ?? ''} onChange={(event) => setSettings({ ...settings, coinmateVariableSymbol: event.target.value || null })} /></label>
        <label><span>Zpráva pro příjemce</span><input disabled={!coinmateUnlocked} aria-label="Coinmate zpráva pro příjemce" type="text" autoComplete="off" value={settings.coinmateRecipientMessage ?? ''} onChange={(event) => setSettings({ ...settings, coinmateRecipientMessage: event.target.value || null })} /></label>
        {unlockWarningOpen && <div className="settings-coinmate-warning" role="alertdialog" aria-labelledby="coinmate-unlock-title" aria-describedby="coinmate-unlock-description">
          <strong id="coinmate-unlock-title">Odemknout platební údaje?</strong>
          <p id="coinmate-unlock-description">Změna těchto hodnot ovlivní všechny budoucí Coinmate QR kódy. Pokračujte jen po ověření údajů přímo v Coinmate.</p>
          <div><button autoFocus type="button" onClick={() => setUnlockWarningOpen(false)}>Zrušit</button><button type="button" onClick={() => { setCoinmateUnlocked(true); setUnlockWarningOpen(false) }}>Ano, upravit údaje</button></div>
        </div>}
      </section>
    </div>
    {!valid && <p className="settings-error">Každý profil musí dávat přesně 100 %.</p>}
    {save.error && <p className="settings-error" role="alert">{save.error.message}</p>}
  </div>
}

function StrategySettingsPane() {
  const overview = useQuery({ queryKey: ['strategy', 'overview'], queryFn: () => apiRequest<StrategyOverview>('/api/strategy/overview'), retry: false })
  if (overview.isPending) return <div className="settings-loading" />
  if (overview.isError) return <SettingsState onRetry={() => overview.refetch()} />
  return <StrategySettingsForm initial={overview.data.settings} />
}

function StrategySettingsForm({ initial }: { initial: StrategySettings }) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState(initial)
  const valid = settings.btcTaxPeriodYears >= 1 && settings.btcTaxPeriodYears <= 20 && settings.checkpointActivationThresholdCzk > 0 && settings.checkpointTriggerFloorCzk >= 0 && settings.checkpointTriggerPercent >= 0 && settings.checkpointTriggerPercent <= 100 && settings.realizationStepProfitCzk > 0 && settings.realizationStepTransferCzk > 0 && settings.vwceRentRatePercent >= 0 && settings.vwceRentRatePercent <= 100
  const save = useMutation({ mutationFn: async () => { const token = await antiforgeryToken(); return apiRequest<StrategySettings>('/api/strategy/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token }, body: JSON.stringify(settings) }) }, onSuccess: async (saved) => { setSettings(saved); await queryClient.invalidateQueries({ queryKey: ['strategy'] }) } })
  const fields: [string, keyof StrategySettings, string, number, number][] = [['Práh aktivace checkpointu', 'checkpointActivationThresholdCzk', 'Kč', 1, 1000], ['Spodní hranice triggeru', 'checkpointTriggerFloorCzk', 'Kč', 0, 1000], ['Trigger jako podíl checkpointu', 'checkpointTriggerPercent', '%', 0, 1], ['Realizace za každých', 'realizationStepProfitCzk', 'Kč zisku', 1, 1000], ['Převést do VWCE', 'realizationStepTransferCzk', 'Kč', 1, 1000], ['Sazba renty VWCE', 'vwceRentRatePercent', '% p.a.', 0, .1], ['Daňový časový test BTC', 'btcTaxPeriodYears', 'roky', 1, 1]]
  return <div className="settings-pane"><SettingsHeading eyebrow="BTC STRATEGIE" title="Checkpoint a realizace zisku" description="Parametry určují aktivaci strategie, profit trigger a doporučenou částku pro přesun do VWCE." valid={valid} save={save} /><div className="strategy-settings-card"><label className="strategy-auto"><span><strong>Automatická aktivace checkpointu</strong><small>Checkpoint se založí při dosažení aktivačního prahu.</small></span><input aria-label="Automatická aktivace checkpointu" type="checkbox" checked={settings.checkpointAuto} onChange={(event) => setSettings({ ...settings, checkpointAuto: event.target.checked })} /></label>{fields.map(([label, key, unit, min, step]) => <label className="strategy-setting-row" key={key}><span>{label}</span><span className="strategy-number-control"><input aria-label={label} type="number" min={min} max={key === 'btcTaxPeriodYears' ? 20 : undefined} step={step} value={settings[key] as number} onChange={(event) => setSettings({ ...settings, [key]: Number(event.target.value) })} /><b>{unit}</b></span></label>)}</div>{!valid && <p className="settings-error">Zkontrolujte rozsahy a kladné částky strategie.</p>}{save.error && <p className="settings-error" role="alert">{save.error.message}</p>}</div>
}

function SettingsHeading({ eyebrow, title, description, valid, save }: { eyebrow: string; title: string; description: string; valid: boolean; save: { isPending: boolean; isSuccess: boolean; mutate: () => void } }) {
  return <div className="settings-section-heading"><div><p>{eyebrow}</p><h2>{title}</h2><span>{description}</span></div><button type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isSuccess ? <Check size={15} /> : <Save size={15} />}{save.isSuccess ? 'Uloženo' : 'Uložit'}</button></div>
}

function SettingsState({ onRetry }: { onRetry: () => void }) { return <div className="settings-state"><Settings size={28} /><h2>Nastavení se nepodařilo načíst</h2><button type="button" onClick={onRetry}>Zkusit znovu</button></div> }

function AllocationProfile({ title, fields, settings, onChange }: { title: string; fields: [string, IncomePercentKey][]; settings: IncomeSettings; onChange: (settings: IncomeSettings) => void }) {
  const total = fields.reduce((sum, [, key]) => sum + Number(settings[key]), 0)
  return <section className="settings-profile"><h3>{title}</h3>{fields.map(([label, key]) => <label key={key}><span>{label}</span><span className="percentage-control"><input aria-label={`${title} ${label}`} type="number" min="0" max="100" step="1" value={settings[key]} onChange={(event) => onChange({ ...settings, [key]: Number(event.target.value) })} /><b>%</b></span></label>)}<div className={total === 100 ? 'valid' : 'invalid'}><span>Součet</span><strong>{total} / 100 %</strong></div></section>
}
