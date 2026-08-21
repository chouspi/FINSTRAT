# FINSTRAT frontend

React 19 klient postaveny pres Vite. V prvni fazi obsahuje pouze responzivni
aplikacni shell a sidebar; pracovni plocha je zamerne prazdna.

```bash
npm install
npm run dev
```

Vite proxy ocekava API na `http://localhost:5080`. Skryty login se otevre tremi
rychlymi kliky na BTC logo.

`DataRefreshProvider` jednim centralnim timerem kazdych 5 sekund obnovuje
vsechny aktivni React Query dotazy. Polling bezi pouze ve viditelne zalozce;
udalost `finstrat:data-changed` umi vyvolat stejny refresh okamzite po mutaci.
