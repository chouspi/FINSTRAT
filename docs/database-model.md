# Databazovy model

## Zakladni rozhodnuti

- Databaze: PostgreSQL 17.
- Identifikatory: nahodne UUID generovane databazi.
- Penize: `numeric(20,2)`, nikoliv floating point.
- BTC a podily: `numeric(20,8)`.
- Okamzik udalosti: `timestamptz`; denni agregace: `date`.
- Vsechna financni data patri domacnosti (`household_id`). Model je tak pripraven
  i na vice uzivatelu bez pozdejsi nebezpecne prestavby dat.
- Financni historie se standardne nemaze. Ucty se archivuji a opravy udalosti
  budou probihat reverzni/opravnou operaci s auditnim zaznamem.
- Menici se doplnkova metadata mohou byt `jsonb`; castky, stavy a vazby zustavaji
  v relacnich sloupcich.

## Proc se nekopiruje SQLite schema 1:1

Soucasny projekt prepocitava FIFO z nakupu a vyberu pri kazdem dotazu. Vazba
vyberu na interni prevod, zivotni vydaj nebo VWCE je polymorfni dvojice
`purpose + purpose_ref_id`, kterou databaze nedokaze ochranit cizim klicem.
Dluh uchovava pouze menitelny aktualni zustatek a obecne nastaveni kombinuje
konfiguraci, tajne hodnoty i odvozeny stav.

Novy model proto:

- uklada spotrebu lotu do `btc_lot_allocations` a `vwce_lot_allocations`;
- pouziva samostatne cizi klice pro prevod, realokaci a zivotni vydaj;
- zachovava puvod lotu pri internim BTC prevodu;
- odvozuje zustatek dluhu z `debt_entries`;
- oddeluje typovane nastaveni strategie, sifrovana tajemstvi a audit;
- uklada puvod a verzi vypoctu portfolioveho snapshotu.

## Hlavni oblasti

### Identita a vlastnictvi dat

`users`, `households` a `household_members` oddeluji prihlaseni od financnich
dat. Role jsou `owner`, `editor` a `viewer`. Kazda domenova tabulka nese
`household_id`; aplikace musi vsechny dotazy filtrovat podle aktivni domacnosti.
Row-level security se zapne az s implementaci autentizace a nastavenim databazove
session promenne, ne drive.

### BTC

`btc_lots` jsou prirustky na custody uctu. `btc_disposals` jsou ubytky a jejich
`kind` urcuje prave jednu explicitni cilovou vazbu. `btc_lot_allocations`
materializuji FIFO rozhodnuti, takze danovy report nezmeni zpetne novy algoritmus.

Interni prevod je jeden `btc_transfers`, navazany zdrojovy disposal a cilove
loty. Cilovy lot odkazuje na zdrojovy lot a nese nove `tax_acquired_at`, protoze
soucasna domenova logika prevodem restartuje casovy test. Toto pravidlo je
potreba pred migraci pravne potvrdit; model umi zachovat i puvodni datum.

### VWCE a strategicke operace

Nakupy jsou `vwce_lots`, prodeje/renta `vwce_disposals`. Prevod BTC do VWCE je
`vwce_reallocations`, na ktery mohou odkazovat BTC disposals i jeden nebo vice
VWCE lotu. Provizorni lot je skutecny boolean a muze byt pozdeji nahrazen
potvrzenym lotem bez pretizene tabulky transferu.

Odlozena realizace je `deferred_vwce_obligations`; jeji cerpani je vazebni
tabulka na konkretni VWCE lot. `original = allocated + cancelled + remaining`
se pri zapisu musi kontrolovat v jedne databazove transakci se zamkem radku.

### Dluhy

`debts` drzi identitu smlouvy, nikoliv menitelny zustatek. `debt_entries` je
ucetni historie typu opening balance, drawdown, payment, interest, fee nebo
adjustment. Pohled `debt_balances` odvozuje aktualni zustatek a datum doplaceni.

### Snapshoty a ceny

`market_prices` zaznamenava pouzity kurz a jeho zdroj. `snapshot_runs` uchovava
verzi algoritmu a kvalitu vypoctu. `portfolio_snapshots` pak obsahuje denni
agregat a volitelne pouzite ceny. Rekonstruovany snapshot je odlisitelny od
pozorovaneho.

### Audit, tajemstvi a idempotence

`audit_events` zapisuje server, aktera, request a dotcenou entitu. Webhook a
dalsi citlive hodnoty patri do `household_secrets` pouze v aplikacne sifrovane
podobe. `idempotency_keys` chrani financni POST operace pred dvojim provedenim.

## Invarianty pro service vrstvu

Nektere souctove podminky nelze rozumne vyjadrit radkovym `CHECK` constraintem.
Backend je proto musi provadet v jedne transakci a zamknout dotcene loty pres
`SELECT ... FOR UPDATE`:

1. Soucet alokaci disposalu se rovna jeho mnozstvi.
2. Soucet alokaci lotu nikdy neprekroci mnozstvi lotu.
3. BTC transfer ma disposal o `gross_quantity_btc` a cilove loty celkem o
   `net_quantity_btc`.
4. Vsechny spojene zaznamy patri stejne domacnosti.
5. Strategicka realokace/vydaj odpovida souctu vynosu napojenych disposalu.
6. Cerpani odlozene realizace neprekroci jeji zbyvajici castku.
7. Dluhovy payment nesmi bez explicitniho povoleni vytvorit zaporny zustatek.

Kompozitni cizi klice v prvni migraci vynucuji bod 4 uz v databazi. Pro body
1-3 a 5-7 vzniknou spolu s write API deferred constraint triggery nebo jedna
uzavrena repository operace; nemaji se obchazet obecnym CRUD API.

## Migrace starych dat

Import ze SQLite bude samostatny, opakovatelny ETL proces. Pred prepnuti musi
vygenerovat report s pocty radku, sirotky, chybejicimi cenami, chronologicky
zapornymi zustatky, soucty BTC/VWCE/dluhu a kontrolou SHA-256 ownership proofu.
Stara numericka ID se nemaji pouzit jako nova PK; mapovani patri do docasne
importni tabulky nebo exportniho reportu.

Otevrena domenova rozhodnuti pred implementaci importu:

- zda interni BTC prevod opravdu vzdy restartuje danovy casovy test;
- zda aplikace zustane pro jednu domacnost, nebo bude verejne multitenantni;
- zda proof dokumenty zustanou v PostgreSQL, nebo se obsah presune do object
  storage a v DB zustane hash, velikost a immutable object key;
- jaky kurz a zaokrouhleni jsou autoritativni pro historicke CZK hodnoty.
