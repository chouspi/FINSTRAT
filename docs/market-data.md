# Market data

`GET /api/market-data/btc-price` vraci aktualni cenu BTC/USD a procentni zmenu
za poslednich 24 hodin z verejneho Coinbase Exchange stats endpointu.
Backend sdili jednu instanci `BtcPriceService`, soubezne requesty serializuje a
externi zdroj kontaktuje nejvyse jednou za 4 sekundy. Pri kratkem vypadku vrati
posledni znamou cenu s `isStale: true`; bez jakekoliv zname ceny odpovi HTTP 503.

`GET /api/market-data/vgla-price` nacita `VGLA.DE` a `EURCZK=X` z Yahoo Finance.
Odpoved obsahuje puvodni `priceEur`, pouzity kurz `eurCzk` i odvozenou hodnotu
`priceCzk`. Trzni zaznam VGLA se uklada v puvodni kotacni mene EUR; CZK slouzi
pro zobrazeni, rentu a agregovane wealth snapshoty.

Frontend nema vlastni timer pro cenu. Aktivni price query obnovuje centralni
petisekundovy refresh spolu s ostatnimi daty a polling se pozastavi, kdyz je
zalozka skryta.
