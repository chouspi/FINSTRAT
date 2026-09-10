import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LockKeyhole, Trash2 } from 'lucide-react'
import { antiforgeryToken, apiRequest } from '../lib/api'
import fakeDeposit from '../assets/last day I gambled/1/pasted file.png'
import scoreLong from '../assets/last day I gambled/2/skore.png'
import thirdScoreLong from '../assets/last day I gambled/3/skore.png'
import fourthPre from '../assets/last day I gambled/4/pre.png'
import fourthPost from '../assets/last day I gambled/4/post.png'
import './LastDayIGambledPage.css'

type CurrentUser = { id: string; isDefault: boolean }
type GamblingCounter = { count: number }

export function LastDayIGambledPage() {
  const [introStage, setIntroStage] = useState(0)
  const [firstRevealed, setFirstRevealed] = useState(false)
  const [secondRevealed, setSecondRevealed] = useState(false)
  const [thirdRevealed, setThirdRevealed] = useState(false)
  const [fourthRevealed, setFourthRevealed] = useState(false)
  const [outroStage, setOutroStage] = useState(0)
  const queryClient = useQueryClient()
  const identity = useQuery({ queryKey: ['identity', 'me'], queryFn: () => apiRequest<CurrentUser>('/api/identity/me'), retry: false })
  const counter = useQuery({
    queryKey: ['identity', 'gambling-counter'],
    queryFn: () => apiRequest<GamblingCounter>('/api/identity/gambling-counter'),
    enabled: Boolean(identity.data && !identity.data.isDefault),
    retry: false,
  })
  const incrementCounter = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken()
      return apiRequest<GamblingCounter>('/api/identity/gambling-counter', { method: 'POST', headers: { 'X-CSRF-TOKEN': token } })
    },
    onSuccess: (value) => queryClient.setQueryData(['identity', 'gambling-counter'], value),
  })

  useEffect(() => {
    const reminder = window.setTimeout(() => setIntroStage(1), 1_000)
    const conclusion = window.setTimeout(() => setIntroStage(2), 2_000)
    return () => { window.clearTimeout(reminder); window.clearTimeout(conclusion) }
  }, [])

  useEffect(() => {
    if (!fourthRevealed) return
    const timers = [1, 2, 3, 4, 5, 6].map((stage) => window.setTimeout(() => setOutroStage(stage), stage * 1_000))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [fourthRevealed])

  if (identity.isPending) return <section className="gambled-page"><div className="gambled-loading" /></section>
  if (!identity.data || identity.data.isDefault) return <section className="gambled-private"><LockKeyhole size={22} /><span>Soukromý obsah</span></section>

  return <section className="gambled-page">
    <header className="gambled-intro"><h2>Dneska se ti chce gamblit, jo?</h2><div className="gambled-intro-sequence" aria-live="polite">{introStage >= 1 && <p>Pamatuješ na 10. 9. 2026, když jsi progamblil výplatu?</p>}{introStage >= 2 && <strong>Ne? Tak já ti to připomenu.</strong>}</div></header>
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
          <span className="gambled-score"><img src={scoreLong} alt="Skóre 11 ku 3 a jeho pokračování" /></span>
        </button>
        <strong className="gambled-loss" aria-hidden={!secondRevealed}>−8k</strong>
      </li>}
      {secondRevealed && <li className={`gambled-card-entry${thirdRevealed ? ' is-revealed' : ''}`}>
        <button className="gambled-card gambled-card--third" type="button" aria-expanded={thirdRevealed} onClick={() => setThirdRevealed(true)}>
          <span className="gambled-number">03</span>
          <span className="gambled-copy"><span className="gambled-thought">OK, dáme comeback na Tipáči. Začneme za 500. Krásně nám ten handicap −4,5 vychází.</span><strong>Jo? A co když thrownou 3v1 into 13:10?</strong></span>
          <span className="gambled-score gambled-score--third"><img src={thirdScoreLong} alt="Skóre comebacku s handicapem minus 4,5" /></span>
        </button>
        <strong className="gambled-loss" aria-hidden={!thirdRevealed}>−500 Kč</strong>
      </li>}
      {thirdRevealed && <li className={`gambled-card-entry${fourthRevealed ? ' is-revealed' : ''}`}>
        <button className="gambled-card gambled-card--fourth" type="button" aria-expanded={fourthRevealed} onClick={() => setFourthRevealed(true)}>
          <span className="gambled-number">04</span>
          <span className="gambled-copy"><span className="gambled-thought">OK, i G2 jsou sráči. Nevadí, hraje Astralis proti naprostým nýmandům. Wait, to jsou až takhle vodhoven hráči? Tak to dám 2,5k na −6,5. COMEBACK IS ON!!!!</span><strong>Jo? A to si myslíš, že Astralis nemůže jednu mapu prodat?… Může…</strong></span>
          <span className="gambled-fourth-image"><img className="gambled-fourth-pre" src={fourthPre} alt="Astralis proti týmu 5STAR před zápasem" /><img className="gambled-fourth-post" src={fourthPost} alt="Astralis prohrává proti týmu 5STAR" aria-hidden={!fourthRevealed} /></span>
        </button>
        <strong className="gambled-loss" aria-hidden={!fourthRevealed}>−2,5k</strong>
      </li>}
    </ol>
    {fourthRevealed && <section className="gambled-outro" aria-live="polite">
      {outroStage >= 1 && <p>Tak to vidíš, co za hovna ti gambling udělal za jeden jediný den.</p>}
      {outroStage >= 2 && <strong className="gambled-total-loss">−14,25k</strong>}
      {outroStage >= 3 && <p>Teď budeš muset dalších 30 dní přežít s tisícovkou na účtu.</p>}
      {outroStage >= 4 && <p>Věřím, že tě tohle už snad nadobro odradí.</p>}
      {outroStage >= 5 && <p>A pokud jsi naprostý kokot a myslíš si: „Ne! Tentokrát to vyjde!“ a fakt jsi tam jako retard zase cokoliv poslal, byť jen korunu, zmáčkni toto tlačítko, ať víš, jaký jsi kokot.</p>}
      {outroStage >= 6 && <button type="button" disabled={incrementCounter.isPending} onClick={() => incrementCounter.mutate()}><span>Zase jsem tam poslal peníze</span><strong>{counter.data?.count ?? 0}×</strong></button>}
    </section>}
  </section>
}
