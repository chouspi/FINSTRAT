# FINSTRAT 2.0

Postupna migrace aplikace FinancialStrategy na modularni monolit v ASP.NET Core,
Reactu a PostgreSQL.

Prvni faze obsahuje pouze navrh databaze. Databazovym systemem je PostgreSQL;
SQLite ani souborova databaze nejsou soucasti nove architektury.

## Obsah

- `database/migrations/` - verzovane a checksumem chranene migrace
- `scripts/import-sqlite.js` - transakcni import stare databaze
- `docs/database-model.md` - rozhodnuti, entity a pravidla modelu
- `docs/identity.md` - defaultni identita, relace a opravneni
- `docs/market-data.md` - zdroj, cache a refresh trznich cen
- `backend/` - ASP.NET Core API a integracni testy
- `frontend/` - React/Vite klient
- `compose.yaml` - lokalni PostgreSQL pro vyvoj

## Lokalni databaze

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
```

Migrator pouziva tabulku `schema_migrations`, kontroluje SHA-256 jiz aplikovanych
migraci a serializuje beh pres PostgreSQL advisory lock.

## Import SQLite

Import potrebuje konzistentni SQLite snapshot, ne kopii otevreneho WAL souboru.
Bezi v jedne PostgreSQL transakci a stejny SHA-256 snapshot nelze importovat
dvakrat. Na stroji musi byt dostupne CLI `sqlite3`.

```bash
npm run db:import:sqlite -- /path/to/data.db
```

Stara ID a vsechna puvodni nastaveni zustanou dohledatelna v `legacy_id_map`
a `legacy_settings`. Importni vysledek je v `data_imports.report`.

## Vyvoj aplikace

API vyzaduje PostgreSQL connection string a ve vyvoji posloucha na portu 5080:

```bash
ConnectionStrings__Database='Host=127.0.0.1;Port=5432;Database=finstrat;Username=finstrat;Password=change-me' \
  dotnet run --project backend/src/Finstrat.Api --urls http://localhost:5080
```

Vite proxy posila `/api` na toto API:

```bash
npm --prefix frontend run dev
```

Cela aplikace vcetne same-origin API proxy se spusti pres:

```bash
docker compose up -d --build
```

Web je ve vychozim nastaveni na `http://127.0.0.1:9200`.

Kontroly frontendu:

```bash
npm --prefix frontend run test
npm --prefix frontend run lint
npm --prefix frontend run build
```

Backend integracni testy pouzivaji skutecny PostgreSQL 17 pres Testcontainers:

```bash
dotnet test Finstrat.slnx
```
