# FINSTRAT 2.0

Postupna migrace aplikace FinancialStrategy na produkcni datovy model.

Prvni faze obsahuje pouze navrh databaze. Databazovym systemem je PostgreSQL;
SQLite ani souborova databaze nejsou soucasti nove architektury.

## Obsah

- `database/migrations/` - verzovane a checksumem chranene migrace
- `scripts/import-sqlite.js` - transakcni import stare databaze
- `docs/database-model.md` - rozhodnuti, entity a pravidla modelu
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
