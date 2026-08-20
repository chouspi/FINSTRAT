# FINSTRAT 2.0

Postupna migrace aplikace FinancialStrategy na produkcni datovy model.

Prvni faze obsahuje pouze navrh databaze. Databazovym systemem je PostgreSQL;
SQLite ani souborova databaze nejsou soucasti nove architektury.

## Obsah

- `database/migrations/0001_initial.sql` - prvni verzovana migrace
- `docs/database-model.md` - rozhodnuti, entity a pravidla modelu
- `compose.yaml` - lokalni PostgreSQL pro vyvoj

## Lokalni databaze

```bash
cp .env.example .env
docker compose up -d
docker compose exec -T postgres \
  psql -U finstrat -d finstrat < database/migrations/0001_initial.sql
```

Migrace je zamerne spustitelna pouze jednou. Az vznikne backend, bude migrace
spravovat zvoleny migracni nastroj a ne startup aplikace.
