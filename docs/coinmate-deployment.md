# Nasazeni serverovych Coinmate nakupu

Zmena vyzaduje soucasne novy Coinmate Controller, FINSTRAT API, frontend a migraci
`0020_coinmate_purchase_jobs.sql`. Zadny zivý obchod neni soucasti testu.

Pred aktualizaci dokoncete puvodni market nakupy a jejich zapisy ze starych
otevrenych prohlizecu. Rozpracovane legacy nakupy se automaticky neprevadeji na
novou serverovou frontu; controller je pouze dohledava bez noveho prikazu.
Uzivatele musi po nasazeni obnovit stranku. Novy API kontrakt uz nespoléha na
ucetni zapis ze stareho klienta.

1. Zalohujte PostgreSQL a volume `coinmate-data` controlleru. SQLite zalohujte
   konzistentne (vcetne WAL, nebo pri zastavene sluzbe).
2. V adresari FINSTRAT2.0 zastavte `web` a `api`: `docker compose stop web api`.
3. Ze stejneho adresare provedte `npm run db:migrate`; migrator vyuzije tamni
   konfiguraci DB a aplikuje take migraci 0020. Stare migrace se nemeni.
4. V adresari CoimateController spustte `docker compose up -d --build`.
5. V adresari FINSTRAT2.0 spustte `docker compose up -d --build api web`.
6. Overte `docker compose logs --tail=100 api` a log controlleru, otevreni BTC →
   API nakupy a nacteni aktualniho minima v dialogu API nakup.

Token `CONTROLLER_API_TOKEN` musi byt stejny v obou projektech. Controller musi
mit zachovany volume `/data`, odchozi HTTPS a pouze jeden proces (`--workers 1`,
jiz nastaveno v Dockerfile). FINSTRAT worker se spousti jen s nakonfigurovanym
`CoinmateController:ApiToken` a pouziva PostgreSQL zamykani mezi instancemi.
Nenastavujte druhy nezavisly controller nad stejnym Coinmate API klicem.

Volitelne promenne controlleru: `PURCHASE_POLL_SECONDS=5`,
`PURCHASE_REPRICE_SECONDS=30`. Zachovano je `MAX_MARKET_BUY_CZK` jako maximalni
rozpocet jednoho nakupu; historicky nazev promenne nema vliv na typ prikazu.
Poplatek 0,4 % se overuje pres `traderFees`, typ maker vynucuje `postOnly=1`.
Skutecny prvni obchod na burze overte malou castkou nad aktualnim minimem:
vyplneni jako MAKER, spravnou skutecnou utratu, jeden lot BTC a zmizeni aktivni
ulohy. Automatizovane testy pouzivaji simulovane odpovedi burzy.

Po spusteni novych uloh nevracejte pouze jeden kontejner na starou verzi a
nemazte frontu ani volumes: ulohy a rezervovane objednavky musi zustat
spojene se svymi idempotency klici.
