# VGLA modul

Prvni vertikalni rez modulu poskytuje owner-scoped read model na
`GET /api/vgla/overview` a frontendovou route `/vgla`.

Viditelny brokersky ucet musi patrit aktualnimu uzivateli pres
`owner_user_id`, nebo mu byt explicitne zpristupnen pres
`vwce_account_shares`. Vlastnik muze ucet sdilet s defaultni identitou;
default pak muze spravovat pohyby, ale zmenu sdileni nadale provadi jen
puvodni vlastnik. Household role sama o sobe pristup nerozsiruje.

Drzene podily a porizovaci cena se pocitaji z materializovanych
`vwce_lot_allocations`. Lot nahrazeny aktivnim lotem pres `replaces_lot_id` se
do aktualnich holdings nezahrnuje. Chybejici cena zpusobi
`costBasisComplete: false`, ne tiche doplneni nulove ceny.

Trzni hodnota pouziva kratce cachovanou cenu `VGLA.DE` a kurz `EURCZK=X` z
Yahoo Finance. Samostatna cena instrumentu se v UI nezobrazuje. Souhrn z ni
pocita hodnotu zbyvajicich podilu, zisk nebo ztratu proti FIFO porizovaci cene
a rentu podle `strategy_settings.vwce_rent_rate_percent` (vychozi 2 % p.a.).
Pokud cena neni dostupna, hodnota a zisk zustanou nezname a renta se po vzoru
legacy aplikace pocita z porizovaci ceny.

`POST /api/vgla/accounts` vytvari owner-scoped broker ucet. Vyplata renty pres
`POST /api/vgla/payouts` vyzaduje `Idempotency-Key`. Pozadovana castka se nejprve
secte s osobnim `vwce_rent_pools.amount_czk`. Dokud soucet nedosahne 100 Kc,
endpoint nevytvori prodej a vrati `deferred: true`; castka zustane v poolu pro
pozdejsi rentu. Po dosazeni minima se cely pool prepocita aktualni cenou na
podily, pool se v teze transakci vynuluje a materializuji se FIFO alokace v
`vwce_lot_allocations`. Zaokrouhleni prodavanych podilu smerem nahoru garantuje,
ze skutecny vynos z prodeje neni mensi nez 100 Kc. Pri vice broker uctech musi
uzivatel zvolit ucet, ze ktereho se podily prodavaji.

V detailu spravovatelneho brokera lze pridat nakup pres
`POST /api/vgla/accounts/{accountId}/purchases`. Endpoint vyzaduje
`Idempotency-Key`, uklada standardni VGLA lot a odmita nakup vlozeny pred
pozdejsi ucetni pohyb. Formular predvyplni aktualni trzni cenu, pokud je
dostupna.

VGLA.DE je kotovano v EUR. Loty, prodeje a FIFO nakladova baze se ukladaji v
puvodni mene EUR (`unit_price_eur`, `proceeds_eur`, `cost_basis_eur`). API pro
trzni cenu vraci take kurz EUR/CZK a vsechny castky zobrazene v UI se prevadeji
do CZK. Migrace `0019_vgla_cutover.sql` zamerne maze drivejsi VWCE ledger;
podily VWCE se nikdy neinterpretuji jako podily VGLA.
