import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowDownLeft, ArrowUpRight, Banknote, CalendarDays, ChevronDown, Landmark, Pencil, PiggyBank, Plus, ShieldCheck, Trash2, TriangleAlert, UserRound, WalletCards, X } from 'lucide-react'
import { antiforgeryToken, apiRequest } from '../lib/api'
import { notifyDataChanged } from '../lib/dataRefresh'
import { createUuid } from '../lib/uuid'
import { dateToIsoTimestamp, formatCzechDate, parseCzechDate, todayIsoDate } from '../lib/date'
import './VwcePage.css'

type VwceOverview = {
  totals: { shares: number; costBasisCzk: number; accountCount: number; costBasisComplete: boolean; provisionalLotCount: number; rentRatePercent: number; rentPoolCzk: number }
  accounts: VwceAccount[]
  recentMovements: VwceMovement[]
}
type VwcePrice = { priceCzk: number; isStale: boolean }
type VwceAccount = {
  id: string; name: string; description: string | null; ownerDisplayName: string
  shares: number; costBasisCzk: number; costBasisComplete: boolean
  lotCount: number; disposalCount: number; provisionalLotCount: number; latestActivityAt: string | null
  isOwnedByCurrentUser: boolean; canManage: boolean; canShareWithDefault: boolean; isSharedWithDefault: boolean
}
type VwceMovement = {
  id: string; accountId: string; accountName: string; type: string; shares: number
  unitPriceCzk: number | null; proceedsCzk: number | null; occurredAt: string; note: string | null
  canEdit?: boolean; canDelete?: boolean
}
type VwcePayoutResult = {
  id: string | null; requestedAmountCzk: number; amountCzk: number; deferred: boolean; rentPoolCzk: number
}

const sharesFormatter = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 8 })
const czkFormatter = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
const dateFormatter = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })
const percentFormatter = new Intl.NumberFormat('cs-CZ', { signDisplay: 'always', minimumFractionDigits: 1, maximumFractionDigits: 1 })

export function VwcePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { dialog } = useSearch({ from: '/vwce' })
  const [ownerMenuAccountId, setOwnerMenuAccountId] = useState<string | null>(null)
  const [accountToEdit, setAccountToEdit] = useState<VwceAccount | null>(null)
  const [accountToDelete, setAccountToDelete] = useState<VwceAccount | null>(null)
  const [purchaseAccount, setPurchaseAccount] = useState<VwceAccount | null>(null)
  const overview = useQuery({ queryKey: ['vwce', 'overview'], queryFn: () => apiRequest<VwceOverview>('/api/vwce/overview'), retry: false })
  const price = useQuery({ queryKey: ['market-data', 'vwce-price'], queryFn: () => apiRequest<VwcePrice>('/api/market-data/vwce-price'), retry: false })
  const sharing = useMutation({
    mutationFn: async ({ accountId, shared }: { accountId: string; shared: boolean }) => {
      const token = await antiforgeryToken()
      await apiRequest(`/api/vwce/accounts/${accountId}/default-share`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({ shared }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['vwce', 'overview'] })
      notifyDataChanged()
    },
  })
  if (overview.isLoading) return <section className="vwce-page"><div className="vwce-summary vwce-summary--loading">{[0, 1, 2].map((item) => <div className="vwce-skeleton" key={item} />)}</div></section>
  if (overview.isError || !overview.data) return <section className="vwce-page vwce-state"><Landmark size={28} /><h2>VWCE data se nepodařilo načíst</h2><button type="button" onClick={() => overview.refetch()}>Zkusit znovu</button></section>

  const data = overview.data
  const priceCzk = validPrice(price.data?.priceCzk)
  const totals = portfolioMetrics(data.totals.shares, data.totals.costBasisCzk, priceCzk)
  const annualRent = totals.valueCzk === null ? null : totals.valueCzk * data.totals.rentRatePercent / 100
  const monthlyRent = annualRent === null ? 0 : annualRent / 12
  const closeDialog = () => void navigate({ to: '/vwce', search: { dialog: undefined }, replace: true })
  return (
    <section className="vwce-page">
      <RentControlCard
        monthlyRent={monthlyRent}
        annualRent={annualRent}
        rentRatePercent={data.totals.rentRatePercent}
        rentPoolCzk={data.totals.rentPoolCzk}
        canPayout={data.accounts.some((account) => account.canManage && account.shares > 0)}
        onPayout={() => void navigate({ to: '/vwce', search: { dialog: 'payout' } })}
      />
      <div className="vwce-portfolio-strip" aria-label="VWCE portfolio">
        <SummaryItem label="Hodnota portfolia" value={totals.valueCzk === null ? '—' : czkFormatter.format(totals.valueCzk)} note={`${sharesFormatter.format(data.totals.shares)} ks`} />
        <SummaryItem label="Zisk / ztráta" value={totals.gainCzk === null ? '—' : signedCzk(totals.gainCzk)} note={totals.gainPercent === null ? undefined : `${percentFormatter.format(totals.gainPercent)} %`} tone={gainTone(totals.gainCzk)} />
        <SummaryItem label="Investováno" value={czkFormatter.format(data.totals.costBasisCzk)} note={data.totals.costBasisComplete ? `${data.totals.accountCount} ${data.totals.accountCount === 1 ? 'broker' : 'brokerů'}` : 'část nákupní ceny chybí'} />
      </div>
      {data.accounts.length === 0 ? (
        <div className="vwce-empty"><div><WalletCards size={25} /></div><h2>Žádné VWCE účty</h2><p>Aktuální identita zatím nevlastní žádný brokerský účet.</p></div>
      ) : <>
        <div className="vwce-section-title">BROKEŘI</div>
        <div className="vwce-accounts">{data.accounts.map((account) => {
          const metrics = portfolioMetrics(account.shares, account.costBasisCzk, priceCzk)
          return <details className="vwce-account" key={account.id}>
            <summary>
              <div className="vwce-account-name"><h3>{account.name}</h3><p>{account.description || 'Bez popisu'}</p></div>
              <div className="vwce-account-balance">
                <div><span>Podíly</span><strong>{sharesFormatter.format(account.shares)} ks</strong></div>
                <div><span>Hodnota</span><strong>{metrics.valueCzk === null ? '—' : czkFormatter.format(metrics.valueCzk)}</strong></div>
                <div><span>Zisk / ztráta</span><strong className={gainTone(metrics.gainCzk)}>{metrics.gainCzk === null ? '—' : signedCzk(metrics.gainCzk)}</strong></div>
              </div>
              <ChevronDown className="vwce-account-chevron" size={18} />
            </summary>
            <div className="vwce-account-detail">
              <span>Investováno <strong>{czkFormatter.format(account.costBasisCzk)}</strong></span>
              <span>{account.lotCount} nákupů · {account.disposalCount} výplat</span>
              {metrics.gainPercent !== null && <span>Výnos <strong className={gainTone(metrics.gainCzk)}>{percentFormatter.format(metrics.gainPercent)} %</strong></span>}
              {account.provisionalLotCount > 0 && <span className="vwce-provisional"><TriangleAlert size={13} /> {account.provisionalLotCount} provizorní</span>}
              {account.canManage && <button className="vwce-add-purchase" type="button" onClick={() => setPurchaseAccount(account)}><Plus size={14} /> Přidat nákup</button>}
              <div className="account-menu-anchor vwce-owner-control">
                <button className="account-tool" type="button" aria-expanded={ownerMenuAccountId === account.id} onClick={() => setOwnerMenuAccountId((current) => current === account.id ? null : account.id)}><UserRound size={14} /> Vlastník</button>
                {ownerMenuAccountId === account.id && <div className="account-menu owner-menu vwce-owner-menu">
                  <span>Vlastník účtu</span>
                  <strong>{account.ownerDisplayName}</strong>
                  {account.canShareWithDefault ? <button className="sharing-switch-row" type="button" role="switch" aria-checked={account.isSharedWithDefault} disabled={sharing.isPending} onClick={() => sharing.mutate({ accountId: account.id, shared: !account.isSharedWithDefault })}><span>Sdílet s defaultem</span><i className={account.isSharedWithDefault ? 'switch-on' : undefined}><b /></i></button> : <p>{account.isOwnedByCurrentUser ? 'Defaultní účet není potřeba sdílet sám se sebou.' : 'Sdílení může změnit pouze vlastník účtu.'}</p>}
                  {sharing.error && <p className="menu-error">{sharing.error.message}</p>}
                </div>}
              </div>
              {account.isOwnedByCurrentUser && <div className="vwce-account-actions"><button type="button" aria-label={`Upravit účet ${account.name}`} onClick={() => setAccountToEdit(account)}><Pencil size={15} /></button><button className="vwce-delete-action" type="button" aria-label={`Odstranit účet ${account.name}`} onClick={() => setAccountToDelete(account)}><Trash2 size={15} /></button></div>}
            </div>
            <VwceAccountMovements accountId={account.id} />
          </details>
        })}</div>
      </>}
      {dialog === 'account' && <CreateVwceAccountDialog onClose={closeDialog} />}
      {dialog === 'payout' && (
        <VwcePayoutDialog
          accounts={data.accounts.filter((account) => account.canManage)}
          monthlyRent={monthlyRent}
          rentRatePercent={data.totals.rentRatePercent}
          rentPoolCzk={data.totals.rentPoolCzk}
          onClose={closeDialog}
        />
      )}
      {accountToEdit && <EditVwceAccountDialog account={accountToEdit} onClose={() => setAccountToEdit(null)} />}
      {accountToDelete && <DeleteVwceAccountDialog account={accountToDelete} onClose={() => setAccountToDelete(null)} />}
      {purchaseAccount && <CreateVwcePurchaseDialog account={purchaseAccount} currentPriceCzk={priceCzk} onClose={() => setPurchaseAccount(null)} />}
    </section>
  )
}

function RentControlCard({ monthlyRent, annualRent, rentRatePercent, rentPoolCzk, canPayout, onPayout }: {
  monthlyRent: number; annualRent: number | null; rentRatePercent: number; rentPoolCzk: number
  canPayout: boolean; onPayout: () => void
}) {
  const nextRent = monthlyRent + rentPoolCzk
  const willDefer = nextRent < 100
  const daysToRent = daysUntilNextRent()
  return <section className="vwce-rent-card" aria-labelledby="vwce-rent-heading">
    <div className="vwce-rent-main">
      <div className="vwce-rent-heading"><span><PiggyBank size={20} /></span><div><h2 id="vwce-rent-heading">Renta z portfolia</h2><p>{sharesFormatter.format(rentRatePercent)} % ročně, vypláceno po dosažení bezpečného minima</p></div></div>
      <div className="vwce-rent-amount"><span>Měsíční renta</span><strong>{annualRent === null ? '—' : czkFormatter.format(monthlyRent)}</strong><small>{annualRent === null ? 'Čeká na tržní cenu' : `${czkFormatter.format(annualRent)} za rok`}</small></div>
      <div className="vwce-rent-countdown"><CalendarDays size={22} /><div><span>Do další renty</span><strong>{daysToRent === 0 ? 'Dnes' : `${daysToRent} ${dayLabel(daysToRent)}`}</strong><small>výplatní den je 1. v měsíci</small></div></div>
      {monthlyRent < 100 && <div className="vwce-rent-pool"><div><span>Renta pool</span><strong>{czkFormatter.format(rentPoolCzk)}</strong></div><div className="vwce-rent-pool-track" aria-hidden="true"><i style={{ width: `${Math.min(100, nextRent)}%` }} /></div><p><ShieldCheck size={14} /> {willDefer ? `Další renta se odloží. Do minima chybí ${czkFormatter.format(100 - nextRent)}.` : `K výplatě je připraveno ${czkFormatter.format(nextRent)}.`}</p></div>}
      <button type="button" disabled={!canPayout || monthlyRent <= 0} onClick={onPayout}><Banknote size={16} />{willDefer ? 'Odložit měsíční rentu' : `Vyplatit ${czkFormatter.format(nextRent)}`}</button>
    </div>
  </section>
}

function daysUntilNextRent() {
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const nextRent = today.getDate() === 1
    ? startOfToday
    : new Date(today.getFullYear(), today.getMonth() + 1, 1)
  return Math.round((nextRent.getTime() - startOfToday.getTime()) / 86_400_000)
}

function dayLabel(days: number) {
  if (days === 1) return 'den'
  if (days >= 2 && days <= 4) return 'dny'
  return 'dní'
}

function CreateVwcePurchaseDialog({ account, currentPriceCzk, onClose }: { account: VwceAccount; currentPriceCzk: number | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const idempotencyKey = useRef(createUuid())
  const [shares, setShares] = useState('')
  const [unitPriceCzk, setUnitPriceCzk] = useState(() => currentPriceCzk === null ? '' : currentPriceCzk.toFixed(2))
  const [acquiredAt, setAcquiredAt] = useState(() => formatCzechDate(todayIsoDate()))
  const [note, setNote] = useState('')
  const total = Number(shares) * Number(unitPriceCzk)
  const mutation = useMutation({
    mutationFn: async () => {
      const parsedDate = parseCzechDate(acquiredAt)
      if (!parsedDate) throw new Error('Datum musí být ve formátu DD.MM.RRRR.')
      const token = await antiforgeryToken()
      return apiRequest(`/api/vwce/accounts/${account.id}/purchases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token, 'Idempotency-Key': idempotencyKey.current },
        body: JSON.stringify({ shares, unitPriceCzk, acquiredAt: dateToIsoTimestamp(parsedDate), note: note || null }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['vwce'] })
      notifyDataChanged()
      onClose()
    },
  })
  return <VwceDialog title={`Přidat nákup · ${account.name}`} kicker="NOVÝ POHYB" onClose={onClose}><form className="vwce-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}><label>Počet podílů<input autoFocus inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} required /></label><label>Cena za podíl (Kč)<input inputMode="decimal" value={unitPriceCzk} onChange={(event) => setUnitPriceCzk(event.target.value)} required /></label>{Number.isFinite(total) && total > 0 && <div className="vwce-purchase-total"><span>Celkem</span><strong>{czkFormatter.format(total)}</strong></div>}<label>Datum nákupu<input inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" value={acquiredAt} onChange={(event) => setAcquiredAt(event.target.value)} required /></label><label>Poznámka <small>volitelné</small><input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>{mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}<div className="vwce-dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="vwce-primary" type="submit" disabled={mutation.isPending || !(Number(shares) > 0) || !(Number(unitPriceCzk) > 0)}><Plus size={15} /> {mutation.isPending ? 'Ukládám…' : 'Přidat nákup'}</button></div></form></VwceDialog>
}

function VwceAccountMovements({ accountId }: { accountId: string }) {
  const [editing, setEditing] = useState<VwceMovement | null>(null)
  const [deleting, setDeleting] = useState<VwceMovement | null>(null)
  const movements = useQuery({
    queryKey: ['vwce', 'accounts', accountId, 'movements'],
    queryFn: () => apiRequest<VwceMovement[]>(`/api/vwce/accounts/${accountId}/movements`),
    retry: false,
  })
  const items = Array.isArray(movements.data) ? movements.data : []
  return <div className="vwce-account-movements"><div>POHYBY NA ÚČTU</div>{movements.isPending
    ? <p>Načítám pohyby…</p>
    : movements.isError
      ? <p>Pohyby se nepodařilo načíst.</p>
      : items.length === 0
        ? <p>Na účtu zatím nejsou žádné pohyby.</p>
        : items.map((movement) => {
            const incoming = movement.shares > 0
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight
            return <div className="vwce-movement vwce-movement--account" key={`${movement.type}-${movement.id}`}><span className={incoming ? 'vwce-movement-in' : 'vwce-movement-out'}><Icon size={15} /></span><div><strong>{movementLabel(movement.type)}</strong><small>{movement.note || movement.accountName}</small></div><time>{dateFormatter.format(new Date(movement.occurredAt))}</time><strong className={incoming ? 'quantity-in' : 'quantity-out'}>{incoming ? '+' : ''}{sharesFormatter.format(movement.shares)} ks</strong><div className="movement-actions">{movement.canEdit && <button type="button" aria-label="Upravit pohyb" onClick={() => setEditing(movement)}><Pencil size={14} /></button>}{movement.canDelete && <button type="button" aria-label="Odstranit pohyb" onClick={() => setDeleting(movement)}><Trash2 size={14} /></button>}</div></div>
          })}{editing && <EditVwceMovementDialog movement={editing} onClose={() => setEditing(null)} />}{deleting && <DeleteVwceMovementDialog movement={deleting} onClose={() => setDeleting(null)} />}</div>
}

function EditVwceMovementDialog({ movement, onClose }: { movement: VwceMovement; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [shares, setShares] = useState(String(movement.shares))
  const [unitPriceCzk, setUnitPriceCzk] = useState(String(movement.unitPriceCzk ?? ''))
  const [acquiredAt, setAcquiredAt] = useState(() => formatCzechDate(movement.occurredAt.slice(0, 10)))
  const [note, setNote] = useState(movement.note ?? '')
  const mutation = useMutation({ mutationFn: async () => { const date = parseCzechDate(acquiredAt); if (!date) throw new Error('Datum musí být ve formátu DD.MM.RRRR.'); const token = await antiforgeryToken(); await apiRequest(`/api/vwce/movements/${movement.id}/purchase`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token }, body: JSON.stringify({ shares, unitPriceCzk, acquiredAt: dateToIsoTimestamp(date), note: note || null }) }) }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['vwce'] }); notifyDataChanged(); onClose() } })
  return <VwceDialog title="Upravit nákup" kicker="POHYB NA ÚČTU" onClose={onClose}><form className="vwce-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}><label>Počet podílů<input autoFocus inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} required /></label><label>Cena za podíl (Kč)<input inputMode="decimal" value={unitPriceCzk} onChange={(event) => setUnitPriceCzk(event.target.value)} required /></label><label>Datum nákupu<input inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" value={acquiredAt} onChange={(event) => setAcquiredAt(event.target.value)} required /></label><label>Poznámka <small>volitelné</small><input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>{mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}<div className="vwce-dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="vwce-primary" type="submit" disabled={mutation.isPending}><Pencil size={15} /> Uložit pohyb</button></div></form></VwceDialog>
}

function DeleteVwceMovementDialog({ movement, onClose }: { movement: VwceMovement; onClose: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({ mutationFn: async () => { const token = await antiforgeryToken(); await apiRequest(`/api/vwce/movements/${movement.id}/purchase`, { method: 'DELETE', headers: { 'X-CSRF-TOKEN': token } }) }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['vwce'] }); notifyDataChanged(); onClose() } })
  return <VwceDialog title="Odstranit nákup" kicker="POHYB NA ÚČTU" onClose={onClose}><p className="vwce-delete-copy">Nákup bude trvale odstraněn. Tato možnost je dostupná pouze proto, že na něj nenavazuje žádný další pohyb.</p>{mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}<div className="vwce-dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="vwce-delete-confirm" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}><Trash2 size={15} /> Odstranit pohyb</button></div></VwceDialog>
}

function EditVwceAccountDialog({ account, onClose }: { account: VwceAccount; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(account.name)
  const [description, setDescription] = useState(account.description ?? '')
  const mutation = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await apiRequest(`/api/vwce/accounts/${account.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token }, body: JSON.stringify({ name, description: description || null }) })
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['vwce'] }); notifyDataChanged(); onClose() },
  })
  return <VwceDialog title="Upravit broker účet" kicker="ÚPRAVA ÚČTU" onClose={onClose}><form className="vwce-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}><label>Název účtu<input autoFocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required /></label><label>Popis <small>volitelné</small><input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>{mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}<div className="vwce-dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="vwce-primary" type="submit" disabled={mutation.isPending || !name.trim()}><Pencil size={15} /> Uložit změny</button></div></form></VwceDialog>
}

function DeleteVwceAccountDialog({ account, onClose }: { account: VwceAccount; onClose: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () => { const token = await antiforgeryToken(); await apiRequest(`/api/vwce/accounts/${account.id}`, { method: 'DELETE', headers: { 'X-CSRF-TOKEN': token } }) },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['vwce'] }); notifyDataChanged(); onClose() },
  })
  return <VwceDialog title="Odstranit broker účet" kicker="ARCHIVACE ÚČTU" onClose={onClose}><p className="vwce-delete-copy">Účet „{account.name}“ zmizí z aktivního přehledu. Historické nákupy a výplaty zůstanou uložené.</p>{mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}<div className="vwce-dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="vwce-delete-confirm" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}><Trash2 size={15} /> Odstranit účet</button></div></VwceDialog>
}

function CreateVwceAccountDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const mutation = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await apiRequest('/api/vwce/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({ name, description: description || null }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['vwce', 'overview'] })
      notifyDataChanged()
      onClose()
    },
  })

  return (
    <VwceDialog title="Nový broker účet" kicker="NOVÝ ÚČET" onClose={onClose}>
      <form className="vwce-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
        <label>Název účtu<input autoFocus value={name} maxLength={100} placeholder="XTB, Degiro, Fio…" onChange={(event) => setName(event.target.value)} required /></label>
        <label>Popis <small>volitelné</small><input value={description} maxLength={500} placeholder="Poznámka" onChange={(event) => setDescription(event.target.value)} /></label>
        {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
        <div className="vwce-dialog-actions">
          <button type="button" onClick={onClose}>Zrušit</button>
          <button className="vwce-primary" type="submit" disabled={mutation.isPending || !name.trim()}><Plus size={15} /> {mutation.isPending ? 'Vytvářím…' : 'Vytvořit účet'}</button>
        </div>
      </form>
    </VwceDialog>
  )
}

function VwcePayoutDialog({ accounts, monthlyRent, rentRatePercent, rentPoolCzk, onClose }: {
  accounts: VwceAccount[]
  monthlyRent: number
  rentRatePercent: number
  rentPoolCzk: number
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const idempotencyKey = useRef(createUuid())
  const accountsWithShares = accounts.filter((account) => account.shares > 0)
  const [accountId, setAccountId] = useState(accountsWithShares[0]?.id ?? accounts[0]?.id ?? '')
  const [amountCzk, setAmountCzk] = useState(() => monthlyRent.toFixed(2))
  const [paidAt, setPaidAt] = useState(() => formatCzechDate(todayIsoDate()))
  const [note, setNote] = useState('')
  const selectedAccount = accounts.find((account) => account.id === accountId)
  const amount = Number(amountCzk)
  const mutation = useMutation({
    mutationFn: async () => {
      const payoutDate = parseCzechDate(paidAt)
      if (!payoutDate) throw new Error('Datum musí být ve formátu DD.MM.RRRR.')
      const token = await antiforgeryToken()
      return apiRequest<VwcePayoutResult>('/api/vwce/payouts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': token,
          'Idempotency-Key': idempotencyKey.current,
        },
        body: JSON.stringify({ accountId, amountCzk, paidAt: dateToIsoTimestamp(payoutDate), note: note || null }),
      })
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['vwce', 'overview'] })
      notifyDataChanged()
      if (!result.deferred) onClose()
    },
  })

  return (
    <VwceDialog title="Výplata renty" kicker="RENTA Z PORTFOLIA" onClose={onClose}>
      <form className="vwce-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
        {accounts.length > 1 && <label>Broker účet<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} — {sharesFormatter.format(account.shares)} ks</option>)}</select></label>}
        <label>
          Částka k výplatě (Kč)
          <input aria-label="Částka k výplatě (Kč)" autoFocus type="number" min="0.01" step="0.01" value={amountCzk} onChange={(event) => setAmountCzk(event.target.value)} required />
          <small className="vwce-field-help">doporučeno (renta {sharesFormatter.format(rentRatePercent)} % p.a.): {czkFormatter.format(monthlyRent)}/měs.</small>
        </label>
        <label>Datum výplaty<input inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" placeholder="DD.MM.RRRR" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} required /></label>
        <label>Poznámka <small>volitelné</small><input value={note} maxLength={500} placeholder="auto-vyplní se" onChange={(event) => setNote(event.target.value)} /></label>
        {selectedAccount && amount > 0 && <p className="vwce-payout-balance">Dostupný účet: <strong>{selectedAccount.name} · {sharesFormatter.format(selectedAccount.shares)} ks</strong></p>}
        {amount > 0 && <div className="vwce-payout-pool"><span>Po započtení poolu</span><strong>{czkFormatter.format(amount + rentPoolCzk)}</strong><small>{amount + rentPoolCzk < 100 ? 'Částka se zatím neprodá a zůstane na později.' : 'Pool se vyčerpá a proběhne výplata.'}</small></div>}
        {accounts.length === 0 && <p className="form-error">Nejdřív vytvořte broker účet.</p>}
        {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
        {mutation.data?.deferred && <p className="vwce-payout-deferred" role="status"><ShieldCheck size={16} /> Renta byla odložena. V poolu je nyní <strong>{czkFormatter.format(mutation.data.rentPoolCzk)}</strong>.</p>}
        <div className="vwce-dialog-actions">
          <button type="button" onClick={onClose}>{mutation.data?.deferred ? 'Zavřít' : 'Zrušit'}</button>
          {!mutation.data?.deferred && <button className="vwce-payout-confirm" type="submit" disabled={mutation.isPending || !accountId || !Number.isFinite(amount) || amount <= 0}>
            <Banknote size={15} /> {mutation.isPending ? 'Ukládám…' : amount + rentPoolCzk < 100 ? 'Odložit do poolu' : 'Potvrdit výplatu'}
          </button>}
        </div>
      </form>
    </VwceDialog>
  )
}

function VwceDialog({ title, kicker, onClose, children }: { title: string; kicker: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="vwce-dialog" role="dialog" aria-modal="true" aria-labelledby="vwce-dialog-title"><button className="dialog-close" type="button" aria-label="Zavřít" onClick={onClose}><X size={18} /></button><p>{kicker}</p><h2 id="vwce-dialog-title">{title}</h2>{children}</section></div>
}

function SummaryItem({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'positive' | 'negative' }) {
  return <div className="vwce-summary-item"><span>{label}</span><strong className={tone}>{value}</strong>{note && <small className={tone}>{note}</small>}</div>
}

function validPrice(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function portfolioMetrics(shares: number, costBasisCzk: number, priceCzk: number | null) {
  const valueCzk = priceCzk === null ? null : shares * priceCzk
  const gainCzk = valueCzk === null || costBasisCzk <= 0 ? null : valueCzk - costBasisCzk
  const gainPercent = gainCzk === null ? null : gainCzk / costBasisCzk * 100
  return { valueCzk, gainCzk, gainPercent }
}

function signedCzk(value: number) {
  return `${value >= 0 ? '+' : ''}${czkFormatter.format(value)}`
}

function gainTone(value: number | null): 'positive' | 'negative' | undefined {
  if (value === null || value === 0) return undefined
  return value > 0 ? 'positive' : 'negative'
}

function movementLabel(type: string) {
  return ({ purchase: 'Nákup', provisional_purchase: 'Provizorní nákup', replacement_purchase: 'Potvrzený nákup', rent_payout: 'Výplata renty', standalone: 'Prodej' } as Record<string, string>)[type] ?? type
}
