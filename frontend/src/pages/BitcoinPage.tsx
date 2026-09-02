import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Archive, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, Bitcoin, ChevronDown, Copy, Download, FileCheck2, Pencil, Plus, Trash2, UserRound, WalletCards, X } from 'lucide-react'
import { antiforgeryToken, apiRequest } from '../lib/api'
import { notifyDataChanged } from '../lib/dataRefresh'
import { createUuid } from '../lib/uuid'
import { dateToIsoTimestamp, formatCzechDate, parseCzechDate, todayIsoDate } from '../lib/date'
import './BitcoinPage.css'

const parseDecimal = (value: string) => Number(value.replace(/\s/g, '').replace(',', '.'))
const apiDecimal = (value: string) => value.replace(/\s/g, '').replace(',', '.')

type BitcoinOverview = {
  totals: {
    quantityBtc: number
    costBasisCzk: number
    accountCount: number
    costBasisComplete: boolean
  }
  accounts: BitcoinAccount[]
  recentMovements: BitcoinMovement[]
}

type BitcoinAccount = {
  id: string
  name: string
  description: string | null
  ownerDisplayName: string
  quantityBtc: number
  costBasisCzk: number
  costBasisComplete: boolean
  lotCount: number
  disposalCount: number
  proofCount: number
  latestActivityAt: string | null
  isOwnedByCurrentUser: boolean
  canManage: boolean
  canShareWithDefault: boolean
  isSharedWithDefault: boolean
  proofs: BitcoinProof[]
}

type BitcoinProof = {
  id: string
  note: string | null
  sha256: string
  createdAt: string
  anchoredAt: string | null
}

type BitcoinProofDetail = {
  id: string
  content: string
  contentSizeBytes: number
  sha256: string
  anchorTxid: string | null
  anchoredAt: string | null
  note: string | null
  createdAt: string
}

type BitcoinMovement = {
  id: string
  accountId: string
  accountName: string
  type: string
  quantityBtc: number
  unitPriceCzk: number | null
  occurredAt: string
  txid: string | null
  note: string | null
  canEdit?: boolean
  canDelete?: boolean
}

type BtcPrice = { priceCzk: number; isStale: boolean }

const expenseCategories = [
  { value: 'auto', label: 'auto' },
  { value: 'hypotéka', label: 'hypotéka' },
  { value: 'bydlení', label: 'bydlení' },
  { value: 'vzdělání', label: 'vzdělání' },
  { value: 'zdraví', label: 'zdraví' },
  { value: 'nouzové výdaje', label: 'nouzové výdaje' },
]

const btcFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 })
const czkFormatter = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
const dateFormatter = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })

function proofTemplate(ownerName: string) {
  const today = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date())
  return `PROHLÁŠENÍ O VLASTNICTVÍ BITCOINOVÝCH ADRES

Já, ${ownerName}, prohlašuji, že k datu ${today} vlastním
následující bitcoinové adresy a mám nad nimi plnou kontrolu:

Adresa 1: bc1q...

SHA-256 hash tohoto dokumentu bude ukotven v OP_RETURN výstupu
transakce odeslané z jedné z uvedených adres zpět na tutéž adresu.`
}

export function BitcoinPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { dialog } = useSearch({ from: '/bitcoin' })
  const [ownerMenuAccountId, setOwnerMenuAccountId] = useState<string | null>(null)
  const [proofAccount, setProofAccount] = useState<BitcoinAccount | null>(null)
  const [accountAction, setAccountAction] = useState<{ account: BitcoinAccount; type: 'purchase' | 'withdrawal' } | null>(null)
  const [accountToEdit, setAccountToEdit] = useState<BitcoinAccount | null>(null)
  const [accountToDelete, setAccountToDelete] = useState<BitcoinAccount | null>(null)
  const [copiedAccountId, setCopiedAccountId] = useState<string | null>(null)
  const copyResetTimer = useRef<number | null>(null)
  const overview = useQuery({
    queryKey: ['bitcoin', 'overview'],
    queryFn: () => apiRequest<BitcoinOverview>('/api/bitcoin/overview'),
    retry: false,
  })
  const price = useQuery({
    queryKey: ['market-data', 'btc-price'],
    queryFn: () => apiRequest<BtcPrice>('/api/market-data/btc-price'),
    retry: false,
  })
  const sharing = useMutation({
    mutationFn: async ({ accountId, shared }: { accountId: string; shared: boolean }) => {
      const token = await antiforgeryToken()
      await apiRequest(`/api/bitcoin/accounts/${accountId}/default-share`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({ shared }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] })
      notifyDataChanged()
    },
  })

  if (overview.isPending) return <BitcoinLoading />
  if (overview.isError) {
    return (
      <section className="bitcoin-page bitcoin-state">
        <Bitcoin size={28} />
        <h2>Bitcoin data se nepodařilo načíst</h2>
        <button type="button" onClick={() => overview.refetch()}>Zkusit znovu</button>
      </section>
    )
  }

  const data = overview.data
  const priceCzk = price.data?.priceCzk
  const marketValueCzk = typeof priceCzk === 'number' ? data.totals.quantityBtc * priceCzk : null
  const closeDialog = () => void navigate({ to: '/bitcoin', search: { dialog: undefined }, replace: true })
  const copyAccountName = async (account: BitcoinAccount) => {
    await navigator.clipboard?.writeText(account.name)
    setCopiedAccountId(account.id)
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopiedAccountId(null), 1800)
  }

  return (
    <section className="bitcoin-page">
      <div className="bitcoin-summary" aria-label="Bitcoin souhrn">
        <SummaryItem label="Celkem" value={`${btcFormatter.format(data.totals.quantityBtc)} BTC`} strong />
        <SummaryItem label="Celková hodnota" value={marketValueCzk === null ? '—' : czkFormatter.format(marketValueCzk)} />
      </div>

      {data.accounts.length === 0 ? (
        <div className="bitcoin-empty">
          <div className="empty-icon"><WalletCards size={25} /></div>
          <h2>Žádné bitcoinové účty</h2>
          <p>Aktuální identita zatím nevlastní žádný BTC účet ani k žádnému nemá sdílený přístup.</p>
        </div>
      ) : (
        <>
          <div className="section-heading">
            <span className="section-title">ÚČTY</span>
          </div>
          <div className="account-grid">
            {data.accounts.map((account) => (
              <details className="bitcoin-account" key={account.id}>
                <summary>
                  <div className="account-heading">
                    <div>
                      <h3>
                        <button
                          className="account-name-copy"
                          type="button"
                          title="Kopírovat název účtu"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            void copyAccountName(account)
                          }}
                        >
                          {account.name}
                          <Copy size={12} />
                        </button>
                      </h3>
                      <p>{account.description || 'Bez popisu'}</p>
                      {copiedAccountId === account.id && <span className="account-copy-status" role="status">Název zkopírován</span>}
                    </div>
                  </div>
                  <div className="account-balance">
                    <div>
                      <span>Zůstatek</span>
                      <strong>{btcFormatter.format(account.quantityBtc)} BTC</strong>
                    </div>
                    <div>
                      <span>Hodnota</span>
                      <strong>{typeof priceCzk === 'number' ? czkFormatter.format(account.quantityBtc * priceCzk) : '—'}</strong>
                    </div>
                  </div>
                  <div className="account-row-controls">
                    {account.isOwnedByCurrentUser && <>
                      <button
                        className="account-row-action account-row-action--delete"
                        type="button"
                        aria-label={`Odstranit účet ${account.name}`}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setAccountToDelete(account)
                        }}
                      ><Trash2 size={15} /></button>
                      <button
                        className="account-row-action"
                        type="button"
                        aria-label={`Upravit účet ${account.name}`}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setAccountToEdit(account)
                        }}
                      ><Pencil size={15} /></button>
                    </>}
                    <ChevronDown className="account-chevron" size={18} />
                  </div>
                </summary>
                <div className="account-toolbar">
                  <div className="account-toolbar-group">
                    <div className="account-menu-anchor">
                      <button
                        className="account-tool"
                        type="button"
                        onClick={() => setProofAccount(account)}
                      >
                        <FileCheck2 size={14} /> Doklady <span>{account.proofCount}</span>
                      </button>
                    </div>
                    <div className="account-menu-anchor">
                      <button
                        className="account-tool"
                        type="button"
                        aria-expanded={ownerMenuAccountId === account.id}
                        onClick={() => setOwnerMenuAccountId((current) => current === account.id ? null : account.id)}
                      >
                        <UserRound size={14} /> Vlastník
                      </button>
                      {ownerMenuAccountId === account.id && (
                        <div className="account-menu owner-menu">
                          <span>Vlastník účtu</span>
                          <strong>{account.ownerDisplayName}</strong>
                          {account.canShareWithDefault ? (
                            <button
                              className="sharing-switch-row"
                              type="button"
                              role="switch"
                              aria-checked={account.isSharedWithDefault}
                              disabled={sharing.isPending}
                              onClick={() => sharing.mutate({ accountId: account.id, shared: !account.isSharedWithDefault })}
                            >
                              <span>Sdílet s defaultem</span>
                              <i className={account.isSharedWithDefault ? 'switch-on' : undefined}><b /></i>
                            </button>
                          ) : (
                            <p>{account.isOwnedByCurrentUser
                              ? 'Defaultní účet není potřeba sdílet sám se sebou.'
                              : 'Sdílení může změnit pouze vlastník účtu.'}</p>
                          )}
                          {sharing.error && <p className="menu-error">{sharing.error.message}</p>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="account-toolbar-group account-toolbar-actions">
                    <button className="account-tool account-tool--withdrawal" type="button" disabled={!account.canManage} onClick={() => setAccountAction({ account, type: 'withdrawal' })}>
                      <ArrowUpRight size={14} /> Výběr
                    </button>
                    <button className="account-tool account-tool--purchase" type="button" disabled={!account.canManage} onClick={() => setAccountAction({ account, type: 'purchase' })}>
                      <Plus size={14} /> Přidat nákup
                    </button>
                    {account.isOwnedByCurrentUser && <>
                      <button className="account-expanded-action" type="button" aria-label={`Upravit účet ${account.name} v detailu`} onClick={() => setAccountToEdit(account)}><Pencil size={15} /></button>
                      <button className="account-expanded-action account-expanded-action--delete" type="button" aria-label={`Odstranit účet ${account.name} v detailu`} onClick={() => setAccountToDelete(account)}><Trash2 size={15} /></button>
                    </>}
                  </div>
                </div>
                <BitcoinAccountMovements accountId={account.id} />
              </details>
            ))}
          </div>

          <div className="section-heading movements-heading">
            <span className="section-title">HISTORIE</span>
          </div>
          <div className="movement-list">
            {data.recentMovements.length === 0 ? (
              <p className="no-movements">Zatím nejsou evidované žádné pohyby.</p>
            ) : data.recentMovements.map((movement) => {
              const incoming = movement.quantityBtc > 0
              const MovementIcon = incoming ? ArrowDownLeft : ArrowUpRight
              return (
                <div className="movement-row" key={`${movement.type}-${movement.id}`}>
                  <div className={`movement-icon ${incoming ? 'movement-in' : 'movement-out'}`}>
                    <MovementIcon size={16} />
                  </div>
                  <div className="movement-primary">
                    <strong>{movementLabel(movement.type)}</strong>
                    <span>{movement.accountName}{movement.note ? ` · ${movement.note}` : ''}</span>
                  </div>
                  <span className="movement-date">{dateFormatter.format(new Date(movement.occurredAt))}</span>
                  <strong className={incoming ? 'quantity-in' : 'quantity-out'}>
                    {incoming ? '+' : ''}{btcFormatter.format(movement.quantityBtc)} BTC
                  </strong>
                </div>
              )
            })}
          </div>
        </>
      )}
      {dialog === 'account' && <CreateAccountDialog onClose={closeDialog} />}
      {dialog === 'transfer' && <TransferDialog accounts={data.accounts.filter((account) => account.canManage)} onClose={closeDialog} />}
      {accountAction?.type === 'purchase' && (
        <PurchaseDialog
          account={accountAction.account}
          accounts={data.accounts.filter((account) => account.canManage)}
          priceCzk={priceCzk}
          onClose={() => setAccountAction(null)}
        />
      )}
      {accountAction?.type === 'withdrawal' && <WithdrawalDialog account={accountAction.account} priceCzk={priceCzk} onClose={() => setAccountAction(null)} />}
      {proofAccount && <ProofsDialog account={proofAccount} onClose={() => setProofAccount(null)} />}
      {accountToEdit && <EditAccountDialog account={accountToEdit} onClose={() => setAccountToEdit(null)} />}
      {accountToDelete && <DeleteAccountDialog account={accountToDelete} onClose={() => setAccountToDelete(null)} />}
    </section>
  )
}

function BitcoinAccountMovements({ accountId }: { accountId: string }) {
  const [editing, setEditing] = useState<BitcoinMovement | null>(null)
  const [deleting, setDeleting] = useState<BitcoinMovement | null>(null)
  const movements = useQuery({
    queryKey: ['bitcoin', 'accounts', accountId, 'movements'],
    queryFn: () => apiRequest<BitcoinMovement[]>(`/api/bitcoin/accounts/${accountId}/movements`),
    retry: false,
  })
  const items = Array.isArray(movements.data) ? movements.data : []

  return <div className="account-movements"><div className="account-movements-title">POHYBY NA ÚČTU</div>{movements.isPending
    ? <p>Načítám pohyby…</p>
    : movements.isError
      ? <p>Pohyby se nepodařilo načíst.</p>
      : items.length === 0
        ? <p>Na účtu zatím nejsou žádné pohyby.</p>
        : items.map((movement) => {
            const incoming = movement.quantityBtc > 0
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight
            return <div className="movement-row movement-row--account" key={`${movement.type}-${movement.id}`}><div className={`movement-icon ${incoming ? 'movement-in' : 'movement-out'}`}><Icon size={16} /></div><div className="movement-primary"><strong>{movementLabel(movement.type)}</strong><span>{movement.note || movement.accountName}</span></div><span className="movement-date">{dateFormatter.format(new Date(movement.occurredAt))}</span><strong className={incoming ? 'quantity-in' : 'quantity-out'}>{incoming ? '+' : ''}{btcFormatter.format(movement.quantityBtc)} BTC</strong><div className="movement-actions">{movement.canEdit && <button type="button" aria-label="Upravit pohyb" onClick={() => setEditing(movement)}><Pencil size={14} /></button>}{movement.canDelete && <button type="button" aria-label="Odstranit pohyb" onClick={() => setDeleting(movement)}><Trash2 size={14} /></button>}</div></div>
          })}{editing && <EditBitcoinMovementDialog movement={editing} onClose={() => setEditing(null)} />}{deleting && <DeleteBitcoinMovementDialog movement={deleting} onClose={() => setDeleting(null)} />}</div>
}

function EditBitcoinMovementDialog({ movement, onClose }: { movement: BitcoinMovement; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [quantityBtc, setQuantityBtc] = useState(String(movement.quantityBtc))
  const [unitPriceCzk, setUnitPriceCzk] = useState(String(movement.unitPriceCzk ?? ''))
  const [acquiredAt, setAcquiredAt] = useState(() => formatCzechDate(movement.occurredAt.slice(0, 10)))
  const [txid, setTxid] = useState(movement.txid ?? '')
  const [note, setNote] = useState(movement.note ?? '')
  const mutation = useMutation({
    mutationFn: async () => { const date = parseCzechDate(acquiredAt); if (!date) throw new Error('Datum musí být ve formátu DD.MM.RRRR.'); const token = await antiforgeryToken(); await apiRequest(`/api/bitcoin/movements/${movement.id}/purchase`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token }, body: JSON.stringify({ quantityBtc, unitPriceCzk, acquiredAt: dateToIsoTimestamp(date), txid: txid || null, note: note || null }) }) },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['bitcoin'] }); notifyDataChanged(); onClose() },
  })
  return <DialogFrame title="Upravit nákup" kicker="POHYB NA ÚČTU" onClose={onClose}><form className="bitcoin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}><div className="form-grid"><label>Množství BTC<input autoFocus inputMode="decimal" value={quantityBtc} onChange={(event) => setQuantityBtc(event.target.value)} required /></label><label>Cena za BTC (Kč)<input inputMode="decimal" value={unitPriceCzk} onChange={(event) => setUnitPriceCzk(event.target.value)} required /></label></div><label>Datum nákupu<input inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" value={acquiredAt} onChange={(event) => setAcquiredAt(event.target.value)} required /></label><label>TXID<input value={txid} maxLength={64} onChange={(event) => setTxid(event.target.value)} /></label><label>Poznámka<input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>{mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}<div className="dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="dialog-primary" type="submit" disabled={mutation.isPending}><Pencil size={15} /> Uložit pohyb</button></div></form></DialogFrame>
}

function DeleteBitcoinMovementDialog({ movement, onClose }: { movement: BitcoinMovement; onClose: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({ mutationFn: async () => { const token = await antiforgeryToken(); await apiRequest(`/api/bitcoin/movements/${movement.id}/purchase`, { method: 'DELETE', headers: { 'X-CSRF-TOKEN': token } }) }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['bitcoin'] }); notifyDataChanged(); onClose() } })
  return <DialogFrame title="Odstranit nákup" kicker="POHYB NA ÚČTU" subtitle="Nákup bude trvale odstraněn. Tato možnost je dostupná pouze proto, že na něj nenavazuje žádný další pohyb." onClose={onClose}>{mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}<div className="dialog-actions account-delete-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="account-delete-confirm" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}><Trash2 size={15} /> Odstranit pohyb</button></div></DialogFrame>
}

function EditAccountDialog({ account, onClose }: { account: BitcoinAccount; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(account.name)
  const mutation = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await apiRequest(`/api/bitcoin/accounts/${account.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({ name }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] })
      notifyDataChanged()
      onClose()
    },
  })

  return (
    <DialogFrame title="Upravit BTC účet" kicker="ÚPRAVA ÚČTU" onClose={onClose}>
      <form className="bitcoin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
        <label>
          Název účtu
          <input autoFocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
        </label>
        {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Zrušit</button>
          <button className="dialog-primary" type="submit" disabled={mutation.isPending || name.trim() === account.name}>
            <Pencil size={15} /> {mutation.isPending ? 'Ukládám…' : 'Uložit název'}
          </button>
        </div>
      </form>
    </DialogFrame>
  )
}

function DeleteAccountDialog({ account, onClose }: { account: BitcoinAccount; onClose: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      await apiRequest(`/api/bitcoin/accounts/${account.id}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-TOKEN': token },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] })
      notifyDataChanged()
      onClose()
    },
  })

  return (
    <DialogFrame title="Odstranit BTC účet" kicker="ARCHIVACE ÚČTU" subtitle={`Účet „${account.name}“ zmizí z aktivního přehledu. Historická data zůstanou bezpečně uložená.`} onClose={onClose}>
      {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
      <div className="dialog-actions account-delete-actions">
        <button type="button" onClick={onClose}>Zrušit</button>
        <button className="account-delete-confirm" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Trash2 size={15} /> {mutation.isPending ? 'Odstraňuji…' : 'Odstranit účet'}
        </button>
      </div>
    </DialogFrame>
  )
}

function CreateAccountDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const mutation = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      return apiRequest('/api/bitcoin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({ name, description: description || null }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] })
      notifyDataChanged()
      onClose()
    },
  })

  return (
    <DialogFrame title="Přidat BTC účet" kicker="NOVÝ ÚČET" onClose={onClose}>
      <form className="bitcoin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
        <label>
          Název účtu
          <input autoFocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          <span className="field-label">Popis <small>nepovinné</small></span>
          <textarea value={description} maxLength={500} rows={3} onChange={(event) => setDescription(event.target.value)} />
        </label>
        {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Zrušit</button>
          <button className="dialog-primary" type="submit" disabled={mutation.isPending}>
            <Plus size={15} /> {mutation.isPending ? 'Ukládám…' : 'Přidat účet'}
          </button>
        </div>
      </form>
    </DialogFrame>
  )
}

function TransferDialog({ accounts, onClose }: { accounts: BitcoinAccount[]; onClose: () => void }) {
  const queryClient = useQueryClient()
  const idempotencyKey = useRef(createUuid())
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?.id ?? '')
  const [toAccountId, setToAccountId] = useState(accounts.find((account) => account.id !== accounts[0]?.id)?.id ?? '')
  const [grossQuantityBtc, setGrossQuantityBtc] = useState('')
  const [feeQuantityBtc, setFeeQuantityBtc] = useState('')
  const [transferredAt, setTransferredAt] = useState(() => formatCzechDate(todayIsoDate()))
  const [note, setNote] = useState('')
  const gross = Number(grossQuantityBtc)
  const fee = Number(feeQuantityBtc || 0)
  const net = Number.isFinite(gross) && Number.isFinite(fee) ? Math.max(0, gross - fee) : 0
  const mutation = useMutation({
    mutationFn: async () => {
      const transferDate = parseCzechDate(transferredAt)
      if (!transferDate) throw new Error('Datum musí být ve formátu DD.MM.RRRR.')
      const token = await antiforgeryToken()
      return apiRequest('/api/bitcoin/transfers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': token,
          'Idempotency-Key': idempotencyKey.current,
        },
        body: JSON.stringify({
          fromAccountId,
          toAccountId,
          grossQuantityBtc,
          feeQuantityBtc: feeQuantityBtc || null,
          transferredAt: dateToIsoTimestamp(transferDate),
          txid: null,
          note: note || null,
        }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] })
      notifyDataChanged()
      onClose()
    },
  })

  return (
    <DialogFrame title="Interní převod" kicker="MEZI BTC ÚČTY" onClose={onClose}>
      {accounts.length < 2 ? (
        <div className="transfer-unavailable">
          <ArrowLeftRight size={22} />
          <p>Pro převod jsou potřeba alespoň dva vlastní BTC účty.</p>
          <button type="button" onClick={onClose}>Zavřít</button>
        </div>
      ) : (
        <form className="bitcoin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
          <div className="form-grid">
            <label>
              Z účtu
              <select value={fromAccountId} onChange={(event) => {
                setFromAccountId(event.target.value)
                if (event.target.value === toAccountId) {
                  setToAccountId(accounts.find((account) => account.id !== event.target.value)?.id ?? '')
                }
              }}>
                {accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
              </select>
            </label>
            <label>
              Na účet
              <select value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
                {accounts.filter((account) => account.id !== fromAccountId)
                  .map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
              </select>
            </label>
          </div>
          <label>
            Množství BTC
            <input inputMode="decimal" placeholder="0.00000000" value={grossQuantityBtc} onChange={(event) => setGrossQuantityBtc(event.target.value)} required />
          </label>
          <div className="form-grid">
            <label>
              <span className="field-label">Poplatek BTC <small>nepovinné</small></span>
              <input inputMode="decimal" placeholder="0.00000000" value={feeQuantityBtc} onChange={(event) => setFeeQuantityBtc(event.target.value)} />
            </label>
            <label>
              Datum převodu
              <input
                inputMode="numeric"
                placeholder="DD.MM.RRRR"
                pattern="\d{1,2}\.\d{1,2}\.\d{4}"
                title="Zadejte datum ve formátu DD.MM.RRRR"
                value={transferredAt}
                onChange={(event) => setTransferredAt(event.target.value)}
                required
              />
            </label>
          </div>
          <label>
            <span className="field-label">Poznámka <small>nepovinné</small></span>
            <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className="transfer-net">
            <span>Na cílový účet dorazí</span>
            <strong>{Number.isFinite(net) ? `${net.toFixed(8)} BTC` : '—'}</strong>
          </div>
          {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>Zrušit</button>
            <button className="dialog-primary" type="submit" disabled={mutation.isPending || !toAccountId}>
              <ArrowLeftRight size={15} /> {mutation.isPending ? 'Převádím…' : 'Provést převod'}
            </button>
          </div>
        </form>
      )}
    </DialogFrame>
  )
}

function ProofsDialog({ account, onClose }: { account: BitcoinAccount; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<BitcoinProofDetail | 'new' | null>(null)
  const [content, setContent] = useState('')
  const [note, setNote] = useState('')
  const [anchorTxid, setAnchorTxid] = useState('')
  const [anchoredAt, setAnchoredAt] = useState('')
  const proofs = useQuery({
    queryKey: ['bitcoin', 'proofs', account.id],
    queryFn: () => apiRequest<BitcoinProofDetail[]>(`/api/bitcoin/accounts/${account.id}/proofs`),
    retry: false,
  })
  const save = useMutation({
    mutationFn: async () => {
      const anchorDate = anchoredAt ? parseCzechDate(anchoredAt) : null
      if (anchoredAt && !anchorDate) throw new Error('Datum musí být ve formátu DD.MM.RRRR.')
      const token = await antiforgeryToken()
      const isNew = editing === 'new'
      return apiRequest(isNew ? `/api/bitcoin/accounts/${account.id}/proofs` : `/api/bitcoin/proofs/${editing?.id}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
        body: JSON.stringify({
          content,
          note: note || null,
          anchorTxid: anchorTxid || null,
          anchoredAt: anchorDate ? dateToIsoTimestamp(anchorDate) : null,
        }),
      })
    },
    onSuccess: async () => {
      setEditing(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bitcoin', 'proofs', account.id] }),
        queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] }),
      ])
    },
  })
  const archive = useMutation({
    mutationFn: async (proofId: string) => {
      const token = await antiforgeryToken()
      await apiRequest(`/api/bitcoin/proofs/${proofId}/archive`, {
        method: 'POST',
        headers: { 'X-CSRF-TOKEN': token },
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bitcoin', 'proofs', account.id] }),
        queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] }),
      ])
    },
  })

  const openForm = (proof?: BitcoinProofDetail) => {
    setEditing(proof ?? 'new')
    setContent(proof?.content ?? proofTemplate(account.ownerDisplayName))
    setNote(proof?.note ?? '')
    setAnchorTxid(proof?.anchorTxid ?? '')
    setAnchoredAt(proof?.anchoredAt ? formatCzechDate(proof.anchoredAt.slice(0, 10)) : '')
  }

  return (
    <div className="dialog-backdrop proof-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="proof-dialog" role="dialog" aria-modal="true" aria-labelledby="proof-dialog-title">
        <header>
          {editing ? (
            <div className="proof-edit-title">
              <button type="button" aria-label="Zpět na seznam dokladů" onClick={() => setEditing(null)}><ArrowLeft size={18} /></button>
              <h2 id="proof-dialog-title">{editing === 'new' ? 'Nový doklad vlastnictví' : 'Upravit doklad vlastnictví'}</h2>
            </div>
          ) : (
            <div><p className="dialog-kicker">DOKLADY VLASTNICTVÍ</p><h2 id="proof-dialog-title">{account.name}</h2></div>
          )}
          <button className="dialog-close" type="button" aria-label="Zavřít" onClick={onClose}><X size={18} /></button>
        </header>
        {editing ? (
          <form className="proof-form bitcoin-form" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
            <label>Text dokumentu<textarea className="proof-content" autoFocus rows={12} spellCheck value={content} onChange={(event) => setContent(event.target.value)} required /></label>
            <p className="proof-hash-help">SHA-256 hash se spočítá po uložení z přesného obsahu (UTF-8). Stažený `.txt` má stejné bajty, takže jeho hash sedí na ten v aplikaci.</p>
            <label><span className="field-label">Datum transakce <small>volitelné</small></span><input inputMode="numeric" placeholder="DD.MM.RRRR" value={anchoredAt} onChange={(event) => setAnchoredAt(event.target.value)} /></label>
            <label><span className="field-label">TXID OP_RETURN transakce <small>doplň po odeslání</small></span><input className="proof-txid" placeholder="64 hex znaků — nech prázdné, dokud transakci nepošleš" value={anchorTxid} maxLength={64} onChange={(event) => setAnchorTxid(event.target.value)} /></label>
            <label><span className="field-label">Poznámka <small>volitelné</small></span><input placeholder="např. hardware peněženka č. 1" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
            <p className="proof-immutability-note">Po uložení TXID se doklad stane trvale neměnným a půjde už pouze stáhnout nebo archivovat.</p>
            {save.error && <p className="form-error" role="alert">{save.error.message}</p>}
            <div className="proof-form-actions"><button type="button" onClick={() => setEditing(null)}>Zrušit</button><button className="proof-save" type="submit" disabled={save.isPending}>{save.isPending ? 'Ukládám…' : 'Uložit doklad'}</button></div>
          </form>
        ) : (
          <div className="proof-list-view">
            <div className="proof-list-toolbar">
              <span>{proofs.data?.length ?? 0} aktivních dokladů</span>
              {account.canManage && <button type="button" onClick={() => openForm()}><Plus size={14} /> Přidat doklad</button>}
            </div>
            <div className="proof-list">
              {proofs.isLoading ? <p className="proof-list-state">Načítám doklady…</p>
                : proofs.isError ? <p className="proof-list-state">Doklady se nepodařilo načíst.</p>
                : proofs.data?.length === 0 ? <p className="proof-list-state">Pro tento účet nejsou uložené žádné doklady.</p>
                : proofs.data?.map((proof) => (
                  <article className="proof-record" key={proof.id}>
                    <div className="proof-record-heading">
                      <span className={proof.anchorTxid ? 'proof-status proof-status--anchored' : 'proof-status'}>{proof.anchorTxid ? 'UKOTVENO' : 'NEUKOTVENO'}</span>
                      <span>vytvořeno {dateFormatter.format(new Date(proof.createdAt))}</span>
                    </div>
                    {proof.note && <p className="proof-note">{proof.note}</p>}
                    <div className="proof-value">
                      <span>SHA-256</span>
                      <code>{proof.sha256}</code>
                      <button type="button" aria-label="Kopírovat SHA-256" onClick={() => void navigator.clipboard?.writeText(proof.sha256)}><Copy size={14} /></button>
                    </div>
                    <div className="proof-value">
                      <span>TRANSAKCE</span>
                      <code>{proof.anchorTxid || 'Zatím bez OP_RETURN transakce'}</code>
                    </div>
                    <div className="proof-record-actions">
                      <a href={`/api/bitcoin/proofs/${proof.id}/content`}><Download size={14} /> .txt</a>
                      {!proof.anchorTxid && account.canManage && <button type="button" onClick={() => openForm(proof)}><Pencil size={14} /> Upravit</button>}
                      {account.canManage && <button className="archive-proof" type="button" disabled={archive.isPending} onClick={() => archive.mutate(proof.id)}><Archive size={14} /> Archivovat</button>}
                    </div>
                  </article>
                ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function PurchaseDialog({
  account,
  accounts,
  priceCzk,
  onClose,
}: {
  account: BitcoinAccount
  accounts: BitcoinAccount[]
  priceCzk: number | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const idempotencyKey = useRef(createUuid())
  const [accountId, setAccountId] = useState(account.id)
  const [quantityBtc, setQuantityBtc] = useState('')
  const [unitPriceCzk, setUnitPriceCzk] = useState('')
  const [totalCzk, setTotalCzk] = useState('')
  const [acquiredAt, setAcquiredAt] = useState(() => formatCzechDate(todayIsoDate()))
  const [txid, setTxid] = useState('')
  const [note, setNote] = useState('')
  const quantity = parseDecimal(quantityBtc)
  const unitPrice = parseDecimal(unitPriceCzk)
  const total = parseDecimal(totalCzk)
  const satsHint = /^\d+$/.test(quantityBtc) && Number(quantityBtc) >= 1000
  const changeQuantity = (value: string) => {
    setQuantityBtc(value)
    const nextQuantity = parseDecimal(value)
    if (nextQuantity > 0 && unitPrice > 0) setTotalCzk((nextQuantity * unitPrice).toFixed(2))
    else if (nextQuantity > 0 && total > 0) setUnitPriceCzk((total / nextQuantity).toFixed(2))
  }
  const changeUnitPrice = (value: string) => {
    setUnitPriceCzk(value)
    const nextPrice = parseDecimal(value)
    setTotalCzk(quantity > 0 && nextPrice > 0 ? (quantity * nextPrice).toFixed(2) : '')
  }
  const changeTotal = (value: string) => {
    setTotalCzk(value)
    const nextTotal = parseDecimal(value)
    setUnitPriceCzk(quantity > 0 && nextTotal > 0 ? (nextTotal / quantity).toFixed(2) : '')
  }
  const mutation = useMutation({
    mutationFn: async () => {
      const date = parseCzechDate(acquiredAt)
      if (!date) throw new Error('Datum musí být ve formátu DD.MM.RRRR.')
      if (!(quantity > 0 && unitPrice > 0)) throw new Error('Zadejte platné množství a cenu.')
      const token = await antiforgeryToken()
      return apiRequest('/api/bitcoin/purchases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': token,
          'Idempotency-Key': idempotencyKey.current,
        },
        body: JSON.stringify({
          accountId,
          quantityBtc: apiDecimal(quantityBtc),
          unitPriceCzk: apiDecimal(unitPriceCzk),
          acquiredAt: dateToIsoTimestamp(date),
          txid: txid || null,
          note: note || null,
        }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] })
      notifyDataChanged()
      onClose()
    },
  })

  return (
    <DialogFrame title="Přidat nákup" kicker="BITCOIN" onClose={onClose}>
      <form className="bitcoin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
        <label>Účet<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Množství BTC<input autoFocus inputMode="decimal" placeholder="0.00000000" value={quantityBtc} onChange={(event) => changeQuantity(event.target.value)} required /></label>
        {satsHint && (
          <div className="sats-hint">
            <span>Myslíš satoshi? {Number(quantityBtc).toLocaleString('cs-CZ')} sat = {(Number(quantityBtc) / 100_000_000).toFixed(8)} BTC</span>
            <button type="button" onClick={() => changeQuantity((Number(quantityBtc) / 100_000_000).toFixed(8))}>Převést</button>
          </div>
        )}
        <div className="purchase-price-heading">
          <span>CENA</span>
          {priceCzk && <button type="button" onClick={() => changeUnitPrice(priceCzk.toFixed(2))}>↗ dosadit aktuální ({czkFormatter.format(priceCzk)})</button>}
        </div>
        <div className="form-grid">
          <label>Za BTC (Kč)<input inputMode="decimal" value={unitPriceCzk} onChange={(event) => changeUnitPrice(event.target.value)} required /></label>
          <label>Celková (Kč)<input inputMode="decimal" value={totalCzk} onChange={(event) => changeTotal(event.target.value)} required /></label>
        </div>
        <label>Datum nákupu<input inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" value={acquiredAt} onChange={(event) => setAcquiredAt(event.target.value)} required /></label>
        <label><span className="field-label">TXID <small>volitelné</small></span><input className="proof-txid" placeholder="hash transakce z blockchainu" value={txid} maxLength={64} onChange={(event) => setTxid(event.target.value)} /></label>
        <label>Poznámka<input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
        {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
        <div className="dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="dialog-primary" type="submit" disabled={mutation.isPending}><Plus size={15} /> {mutation.isPending ? 'Ukládám…' : 'Přidat nákup'}</button></div>
      </form>
    </DialogFrame>
  )
}

function WithdrawalDialog({ account, priceCzk, onClose }: { account: BitcoinAccount; priceCzk: number | undefined; onClose: () => void }) {
  const queryClient = useQueryClient()
  const idempotencyKey = useRef(createUuid())
  const [quantityBtc, setQuantityBtc] = useState('')
  const [withdrawnAt, setWithdrawnAt] = useState(() => formatCzechDate(todayIsoDate()))
  const [txid, setTxid] = useState('')
  const [note, setNote] = useState('')
  const [purpose, setPurpose] = useState<'standalone' | 'life_expense'>('standalone')
  const [expenseCategory, setExpenseCategory] = useState('auto')
  const quantity = Number(quantityBtc)
  const currentValueCzk = quantity > 0 && priceCzk ? quantity * priceCzk : null
  const mutation = useMutation({
    mutationFn: async () => {
      const date = parseCzechDate(withdrawnAt)
      if (!date) throw new Error('Datum musí být ve formátu DD.MM.RRRR.')
      const token = await antiforgeryToken()
      return apiRequest('/api/bitcoin/withdrawals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': token,
          'Idempotency-Key': idempotencyKey.current,
        },
        body: JSON.stringify({
          accountId: account.id,
          quantityBtc,
          unitPriceCzk: priceCzk ? priceCzk.toFixed(2) : null,
          withdrawnAt: dateToIsoTimestamp(date),
          txid: txid || null,
          note: note || null,
          purpose,
          lifeExpenseCategory: purpose === 'life_expense' ? expenseCategory : null,
        }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bitcoin', 'overview'] })
      notifyDataChanged()
      onClose()
    },
  })

  return (
    <DialogFrame
      title="Výběr BTC"
      kicker="BITCOIN"
      subtitle={`${account.name} · dostupné: ${btcFormatter.format(account.quantityBtc)} BTC`}
      onClose={onClose}
    >
      <form className="bitcoin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
        <fieldset className="withdrawal-purpose">
          <legend>Účel výběru</legend>
          <div>
            <button className={purpose === 'standalone' ? 'purpose-selected' : undefined} type="button" onClick={() => setPurpose('standalone')}>Bez účelu</button>
            <button className={purpose === 'life_expense' ? 'purpose-selected purpose-expense' : undefined} type="button" onClick={() => setPurpose('life_expense')}>Životní výdaj</button>
          </div>
          <p>{purpose === 'life_expense'
            ? <>Checkpoint: <strong>klesne o {currentValueCzk ? czkFormatter.format(currentValueCzk) : '—'}</strong></>
            : <>Checkpoint se nezmění — profit vůči němu klesne. Pokud jde o útratu, zvol <strong>Životní výdaj</strong>.</>}</p>
        </fieldset>
        {purpose === 'life_expense' && (
          <fieldset className="expense-categories">
            <legend>Kategorie výdaje</legend>
            <div>{expenseCategories.map((category) => (
              <button
                className={expenseCategory === category.value ? 'category-selected' : undefined}
                type="button"
                key={category.value}
                onClick={() => {
                  setExpenseCategory(category.value)
                  if (!note) setNote(category.value)
                }}
              >{category.label}</button>
            ))}</div>
          </fieldset>
        )}
        <label>Množství BTC<input autoFocus inputMode="decimal" placeholder="0.00000000" value={quantityBtc} onChange={(event) => setQuantityBtc(event.target.value)} required /></label>
        <label>Datum výběru<input inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" value={withdrawnAt} onChange={(event) => setWithdrawnAt(event.target.value)} required /></label>
        <label><span className="field-label">TXID <small>volitelné</small></span><input className="proof-txid" placeholder="hash transakce z blockchainu" value={txid} maxLength={64} onChange={(event) => setTxid(event.target.value)} /></label>
        <label>Poznámka<input placeholder="auto-vyplní se podle účelu" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
        {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
        <div className="dialog-actions"><button type="button" onClick={onClose}>Zrušit</button><button className="dialog-primary withdrawal-submit" type="submit" disabled={mutation.isPending}><ArrowUpRight size={15} /> {mutation.isPending ? 'Ukládám…' : 'Zaznamenat výběr'}</button></div>
      </form>
    </DialogFrame>
  )
}

function DialogFrame({
  title,
  kicker,
  subtitle,
  onClose,
  children,
}: {
  title: string
  kicker: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="bitcoin-dialog" role="dialog" aria-modal="true" aria-labelledby="bitcoin-dialog-title">
        <button className="dialog-close" type="button" aria-label="Zavřít" onClick={onClose}><X size={18} /></button>
        <p className="dialog-kicker">{kicker}</p>
        <h2 id="bitcoin-dialog-title">{title}</h2>
        {subtitle && <p className="dialog-subtitle">{subtitle}</p>}
        {children}
      </section>
    </div>
  )
}

function SummaryItem({ label, value, note, strong = false }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <div className={`summary-item${strong ? ' summary-item--strong' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  )
}

function BitcoinLoading() {
  return (
    <section className="bitcoin-page" aria-label="Načítání Bitcoin dat">
      <div className="bitcoin-summary bitcoin-summary--loading">
        {[0, 1].map((item) => <div className="summary-skeleton" key={item} />)}
      </div>
    </section>
  )
}

function movementLabel(type: string) {
  const labels: Record<string, string> = {
    purchase: 'Nákup',
    internal_transfer_in: 'Příchozí převod',
    internal_transfer: 'Odchozí převod',
    life_expense: 'Životní výdaj',
    vwce_reallocation: 'Převod do VWCE',
    standalone: 'Výběr',
  }
  return labels[type] ?? type
}
