# Identity modul

## Chovani

- Bez prihlasovaci cookie obdrzi kazdy request principal `Default User`.
- Defaultni identita nema heslo a nelze se za ni prihlasit login formularem.
- Prihlaseni jineho uzivatele vytvori sifrovany HTTP-only cookie ticket na
  presne 15 minut. Relace se neposouva aktivitou.
- Logout odstrani cookie a dalsi request automaticky pokracuje jako default.
- Login ve frontendu nema viditelny odkaz. Otevre se tremi rychlymi kliky na
  BTC logo.
- Stavove endpointy vyzaduji antiforgery cookie a `X-CSRF-TOKEN` header.

## Opravneni

Uzivatel patri do domacnosti pres `household_members` s roli `owner`, `editor`
nebo `viewer`. Role a aktivni domacnost jsou soucasti serverem podepsaneho
principal ticketu.

Kazdy `btc_accounts` i `vwce_accounts` ma prave jednoho `owner_user_id`. Pristup
dalsich uzivatelu k BTC uctu lze pozdeji ukladat do `btc_account_shares`.
Pri zapisu se vlastnictvi overuje kompozitnim cizim klicem proti clenstvi ve
stejne domacnosti. Dokud nevznikne sprava sdileni v UI, zadne ucty se nesdili.

## API

- `GET /api/identity/me` - aktualni nebo defaultni identita
- `GET /api/identity/antiforgery` - jednorazovy request token
- `POST /api/identity/login` - vytvori 15minutovou relaci
- `POST /api/identity/logout` - vrati klienta do defaultni identity
- `GET /api/identity/users` - seznam clenu, pouze owner
- `POST /api/identity/users` - zalozeni dalsiho uctu, pouze owner

Skryty login je UX pozadavek, nikoliv bezpecnostni hranice. Produkcni nasazeni
musí byt dostupne pouze v duveryhodne siti nebo za dalsi sitovou autentizaci,
protoze defaultni identita ma plnohodnotny pristup k vlastnim financnim datum.
