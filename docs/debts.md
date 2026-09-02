# Dluhy

Modul pouziva event ledger `debt_entries`; aktualni zustatek se vzdy odvozuje
z pohybu pres `debt_balances` a nelze jej prepsat editaci metadat dluhu. Kazdy
dluh ma vlastnika a API vraci i meni pouze dluhy aktualniho uzivatele.

`GET /api/debts/overview` vraci souhrn, aktivni i splacene zavazky a posledni
pohyby. `GET /api/debts/{id}/entries` vraci kompletni historii konkretniho
dluhu.

Vytvoreni dluhu zapise identitu a `opening_balance` v jedne transakci. Splátka
pres `POST /api/debts/{id}/payments` vyzaduje `Idempotency-Key`, zamyka dluh,
odmita preplatek a pri nulovem zustatku nastavi `closed_at`. Splaceny dluh lze
archivovat; historie zustava zachovana. Editace meni pouze nazev, prioritu,
typ hypoteky a poznamku.

Vlastnik muze splatku odstranit pres
`DELETE /api/debts/{id}/payments/{paymentId}`. Operace prijima pouze entry typu
`payment` nebo `scheduled_payment`, probiha pod zamkem, pripadne zrusi `closed_at` a zapise auditni
udalost.

Priorita 0 znamena mimo automaticky plan spláceni, 5 nejvyssi prioritu.
Hypoteky jsou v souhrnu oddelene od ostatnich dluhu urcenych k prednostnimu
splaceni.

Dialog `Sprava dluhu` zobrazuje vsechny nearchivovane zavazky. U beznych dluhu
umoznuje rychle menit prioritu 0 az 5; zmena se ihned projevi v Income planu.
Hypoteky zustavaji mimo automaticky plan. Ze stejneho dialogu lze otevrit plnou
editaci metadat a archivovat splaceny dluh.

Splátka s budoucim datem se uklada jako `scheduled_payment`. Do potvrzeni
nesnizuje zustatek dluhu a je zahrnuta do rezervy Income planu. Po dosazeni data
splatnosti ji uzivatel potvrdi pres
`POST /api/debts/scheduled-payments/due/confirm`; teprve pak se zmeni na
`payment`. Dashboard na splatne zaznamy upozorni a stranka Dluhy zobrazi akci
pro jejich hromadne potvrzeni. Po potvrzeni klient nabidne vytvoreni stejne
splátky v nejblizsim budoucim mesici; kalendarni posun korektne prevadi prosinec
na leden a respektuje delku mesice.

Vsechny cekajici zaznamy jsou na strance Dluhy v samostatne skupine `Planovane
splatky` mezi aktivnimi zavazky a poslednimi pohyby. Jednotlivou splatku lze
potvrdit i pred terminem pres
`POST /api/debts/scheduled-payments/{paymentId}/confirm`.
