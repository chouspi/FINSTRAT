# Market data

`GET /api/market-data/btc-price` vraci aktualni cenu BTC/USD a procentni zmenu
za poslednich 24 hodin z verejneho Coinbase Exchange stats endpointu.
Backend sdili jednu instanci `BtcPriceService`, soubezne requesty serializuje a
externi zdroj kontaktuje nejvyse jednou za 4 sekundy. Pri kratkem vypadku vrati
posledni znamou cenu s `isStale: true`; bez jakekoliv zname ceny odpovi HTTP 503.

Frontend nema vlastni timer pro cenu. Aktivni price query obnovuje centralni
petisekundovy refresh spolu s ostatnimi daty a polling se pozastavi, kdyz je
zalozka skryta.
