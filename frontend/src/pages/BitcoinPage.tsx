import { useQuery } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, Bitcoin, ShieldCheck, WalletCards } from 'lucide-react'
import { apiRequest } from '../lib/api'
import './BitcoinPage.css'

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
}

type BtcPrice = { priceUsd: number; isStale: boolean }

const btcFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 })
const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const czkFormatter = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
const dateFormatter = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })

export function BitcoinPage() {
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
  const priceUsd = price.data?.priceUsd
  const marketValueUsd = typeof priceUsd === 'number' ? data.totals.quantityBtc * priceUsd : null

  return (
    <section className="bitcoin-page">
      <div className="bitcoin-summary" aria-label="Bitcoin souhrn">
        <SummaryItem label="Drženo" value={`${btcFormatter.format(data.totals.quantityBtc)} BTC`} strong />
        <SummaryItem label="Tržní hodnota" value={marketValueUsd === null ? '—' : usdFormatter.format(marketValueUsd)} />
        <SummaryItem
          label="Nákladová báze"
          value={czkFormatter.format(data.totals.costBasisCzk)}
          note={data.totals.costBasisComplete ? undefined : 'část ceny chybí'}
        />
        <SummaryItem label="Aktivní účty" value={String(data.totals.accountCount)} />
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
            <div>
              <span>ÚČTY</span>
              <h2>Bitcoinová úschova</h2>
            </div>
            <span>{data.accounts.length}</span>
          </div>
          <div className="account-grid">
            {data.accounts.map((account) => (
              <article className="bitcoin-account" key={account.id}>
                <div className="account-heading">
                  <div className="account-mark"><Bitcoin size={18} /></div>
                  <div>
                    <h3>{account.name}</h3>
                    <p>{account.description || 'Bez popisu'}</p>
                  </div>
                  <div className="account-owner"><span>Vlastník</span><strong>{account.ownerDisplayName}</strong></div>
                </div>
                <div className="account-balance">
                  <div>
                    <span>Zůstatek</span>
                    <strong>{btcFormatter.format(account.quantityBtc)} BTC</strong>
                  </div>
                  <div>
                    <span>Hodnota</span>
                    <strong>{typeof priceUsd === 'number' ? usdFormatter.format(account.quantityBtc * priceUsd) : '—'}</strong>
                  </div>
                </div>
                <div className="account-meta">
                  <span>Nákladová báze <strong>{czkFormatter.format(account.costBasisCzk)}</strong></span>
                  <span className={account.proofCount > 0 ? 'proof-ok' : undefined}>
                    <ShieldCheck size={13} /> {account.proofCount} dokladů
                  </span>
                </div>
              </article>
            ))}
          </div>

          <div className="section-heading movements-heading">
            <div>
              <span>HISTORIE</span>
              <h2>Poslední pohyby</h2>
            </div>
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
    </section>
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
        {[0, 1, 2, 3].map((item) => <div className="summary-skeleton" key={item} />)}
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
