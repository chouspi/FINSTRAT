import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LockKeyhole } from 'lucide-react'
import { apiRequest } from '../lib/api'
import fakeDeposit from '../assets/last day I gambled/1/pasted file.png'
import './LastDayIGambledPage.css'

type CurrentUser = { isDefault: boolean }

export function LastDayIGambledPage() {
  const [firstRevealed, setFirstRevealed] = useState(false)
  const identity = useQuery({ queryKey: ['identity', 'me'], queryFn: () => apiRequest<CurrentUser>('/api/identity/me'), retry: false })

  if (identity.isPending) return <section className="gambled-page"><div className="gambled-loading" /></section>
  if (!identity.data || identity.data.isDefault) return <section className="gambled-private"><LockKeyhole size={22} /><span>Soukromý obsah</span></section>

  return <section className="gambled-page">
    <header className="gambled-intro"><span>PRIVATE ARCHIVE</span><h2>last day I gambled</h2><time dateTime="2026-09-10">10. 9. 2026</time></header>
    <ol className="gambled-cards">
      <li className={firstRevealed ? 'is-revealed' : undefined}>
        <button className="gambled-card gambled-card--first" type="button" aria-expanded={firstRevealed} onClick={() => setFirstRevealed((value) => !value)}>
          <span className="gambled-number">01</span>
          <span className="gambled-copy"><span className="gambled-thought">ok, mam po vyplate 12k v btc, depositnu jen 3,5 a kdyz prohraju tak se toho nedotknu</span><strong>jo? a do kdyz ti polymarket nabidne pro deposit falesny účet?</strong></span>
          <span className="gambled-proof"><img src={fakeDeposit} alt="Falešný Polymarket deposit účet" /></span>
        </button>
        <strong className="gambled-loss" aria-hidden={!firstRevealed}>−3,5k</strong>
      </li>
      {[2, 3, 4].map((item) => <li key={item}><div className="gambled-card gambled-card--empty" aria-label={`Připravená karta ${item}`}><span className="gambled-number">0{item}</span><i /></div></li>)}
    </ol>
  </section>
}
