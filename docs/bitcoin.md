# Bitcoin modul

Prvni verze modulu je owner-scoped read model dostupny na
`GET /api/bitcoin/overview`. Vraci agregovany zustatek, zbyvajici nakladovou
bazi, aktivni ucty a poslednich 12 pohybu.

Viditelny ucet musi patrit aktualnimu uzivateli pres `owner_user_id`, nebo byt
explicitne uveden v `btc_account_shares`. Household role sama o sobe pristup k
uctu neposkytuje. Po loginu a logoutu frontend okamzite odstrani Bitcoin cache,
aby data predchozi identity nezustala zobrazena ani do dalsiho 5s refresh ticku.

Nakladova baze se pocita pouze ze zbyvajiciho mnozstvi jednotlivych `btc_lots`
po odecteni materializovanych `btc_lot_allocations`. Chybejici cena se v API
projevi pres `costBasisComplete: false`, ne tichym doplnenim nulove ceny.

Frontendova route `/bitcoin` obsahuje:

- souhrn drzenych BTC a celkove hodnoty i porizovaci ceny v CZK;
- rozbalovaci seznam pristupnych uctu se zustatkem, doklady a vlastnikem;
- owner-only prepinac sdileni uctu s defaultnim uzivatelem;
- idempotentni nakup, FIFO vyber a interni prevod mezi vlastnimi ucty;
- posledni nakupy, vybery a interni pohyby;
- samostatny prazdny, loading a error stav.

Financni mutace budou nasledovat jako transakcni workflow s idempotenci,
zamkem lotu, serverovym FIFO preview a auditem. Nebudou implementovany jako
obecny edit/delete CRUD.
