import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LockKeyhole, Trash2 } from 'lucide-react'
import { apiRequest } from '../lib/api'
import fakeDeposit from '../assets/last day I gambled/1/pasted file.png'
import scoreShort from '../assets/last day I gambled/2/skore short.png'
import scoreLong from '../assets/last day I gambled/2/skore.png'
import './LastDayIGambledPage.css'

type CurrentUser = { isDefault: boolean }

export function LastDayIGambledPage() {
  const [firstRevealed, setFirstRevealed] = useState(false)
  const [secondRevealed, setSecondRevealed] = useState(false)
  const [thirdRevealed, setThirdRevealed] = useState(false)
  const identity = useQuery({ queryKey: ['identity', 'me'], queryFn: () => apiRequest<CurrentUser>('/api/identity/me'), retry: false })

  if (identity.isPending) return <section className="gambled-page"><div className="gambled-loading" /></section>
  if (!identity.data || identity.data.isDefault) return <section className="gambled-private"><LockKeyhole size={22} /><span>Soukromý obsah</span></section>

  return <section className="gambled-page">
    <header className="gambled-intro"><span>PRIVATE ARCHIVE</span><h2>last day I gambled</h2><time dateTime="2026-09-10">10. 9. 2026</time></header>
    <ol className="gambled-cards">
      <li className={firstRevealed ? 'is-revealed' : undefined}>
        <button className="gambled-card gambled-card--first" type="button" aria-expanded={firstRevealed} onClick={() => setFirstRevealed(true)}>
          <span className="gambled-number">01</span>
          <span className="gambled-copy"><span className="gambled-thought">OK, mám po výplatě 12k v BTC. Depositnu jen 3,5k a když prohraju, tak se toho nedotknu.</span><strong>Jo? A co když ti Polymarket nabídne pro deposit falešný účet?</strong></span>
          <span className="gambled-proof"><img src={fakeDeposit} alt="Falešný Polymarket deposit účet" /><span className="gambled-trash" aria-hidden="true"><Trash2 size={52} strokeWidth={2.3} /></span></span>
        </button>
        <strong className="gambled-loss" aria-hidden={!firstRevealed}>−3,5k</strong>
      </li>
      {firstRevealed && <li className={`gambled-card-entry${secondRevealed ? ' is-revealed' : ''}`}>
        <button className="gambled-card gambled-card--second" type="button" aria-expanded={secondRevealed} onClick={() => setSecondRevealed(true)}>
          <span className="gambled-number">02</span>
          <span className="gambled-copy"><span className="gambled-thought">OK, Polymarket programovali kokoti. Vyhraju to zpátky, není problém. Už to skoro vyhráli, je to 11:3.</span><strong>Jo? A co když prohrají deset roundů po sobě?</strong></span>
          <span className="gambled-score"><img className="gambled-score-short" src={scoreShort} alt="Krátké skóre 11 ku 3" aria-hidden={secondRevealed} /><img className="gambled-score-long" src={scoreLong} alt="Prodloužené skóre po deseti prohraných kolech" aria-hidden={!secondRevealed} /></span>
        </button>
        <strong className="gambled-loss" aria-hidden={!secondRevealed}>−8k</strong>
      </li>}
      {secondRevealed && <li className="gambled-card-entry"><button className="gambled-card gambled-card--empty" type="button" aria-label="Připravená karta 3" onClick={() => setThirdRevealed(true)}><span className="gambled-number">03</span><i /></button></li>}
      {thirdRevealed && <li className="gambled-card-entry"><div className="gambled-card gambled-card--empty" aria-label="Připravená karta 4"><span className="gambled-number">04</span><i /></div></li>}
    </ol>
  </section>
}
