# VWCE modul

Prvni vertikalni rez modulu poskytuje owner-scoped read model na
`GET /api/vwce/overview` a frontendovou route `/vwce`.

Viditelny brokersky ucet musi patrit aktualnimu uzivateli pres
`owner_user_id`, nebo mu byt explicitne zpristupnen pres
`vwce_account_shares`. Vlastnik muze ucet sdilet s defaultni identitou;
default pak muze spravovat pohyby, ale zmenu sdileni nadale provadi jen
puvodni vlastnik. Household role sama o sobe pristup nerozsiruje.

Drzene podily a porizovaci cena se pocitaji z materializovanych
`vwce_lot_allocations`. Lot nahrazeny aktivnim lotem pres `replaces_lot_id` se
do aktualnich holdings nezahrnuje. Chybejici cena zpusobi
`costBasisComplete: false`, ne tiche doplneni nulove ceny.

Trzni hodnota pouziva kratce cachovanou cenu `VWCE.AS` a kurz `EURCZK=X` z
Yahoo Finance. Samostatna cena instrumentu se v UI nezobrazuje. Souhrn z ni
pocita hodnotu zbyvajicich podilu, zisk nebo ztratu proti FIFO porizovaci cene
a rentu podle `strategy_settings.vwce_rent_rate_percent` (vychozi 2 % p.a.).
Pokud cena neni dostupna, hodnota a zisk zustanou nezname a renta se po vzoru
legacy aplikace pocita z porizovaci ceny.

`POST /api/vwce/accounts` vytvari owner-scoped broker ucet. Vyplata renty pres
`POST /api/vwce/payouts` vyzaduje `Idempotency-Key`, prepocita zadanou CZK
castku aktualni cenou na podily a materializuje FIFO alokace v
`vwce_lot_allocations`. Vyplata proto snizi podily, FIFO porizovaci cenu i
nasledujici vypocet renty. Pri vice broker uctech musi uzivatel zvolit ucet,
ze ktereho se podily prodavaji.

V detailu spravovatelneho brokera lze pridat nakup pres
`POST /api/vwce/accounts/{accountId}/purchases`. Endpoint vyzaduje
`Idempotency-Key`, uklada standardni VWCE lot a odmita nakup vlozeny pred
pozdejsi ucetni pohyb. Formular predvyplni aktualni trzni cenu, pokud je
dostupna.
