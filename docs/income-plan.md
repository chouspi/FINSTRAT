# Income plan

Income plan uklada vychozi kapital a dva alokacni profily samostatne pro kazdeho
uzivatele. Bez aktivniho spotrebitelskeho dluhu deli prijem mezi BTC a cash. Pri
aktivnim dluhu prida rozpocet pro predcasne splatky. Hypoteky a dluhy s prioritou
0 jsou mimo automaticke rozdeleni.

Splátkovy rozpocet se deli podle priorit 1 az 5. Pokud navrzena splatka prekroci
zustatek maleho dluhu, zbytek se opakovane prerozdeli mezi ostatni zpusobile
dluhy. Soucet navrzenych splatek je proto `min(rozpocet, zpusobile zustatky)`.

`GET /api/income-plan/overview` vraci profil a aktivni dluhy aktualniho
uzivatele. `PUT /api/income-plan/settings` uklada profil; soucet procent v kazdem
rezimu musi byt presne 100.

Prihlaseny uzivatel muze z hlavicky otevrit workflow `Zpracovat prijem`. Wizard
odpovida legacy rozlozeni: ukaze barevny rozpad, samostatny modal pro zapis BTC
nakupu, hromadny zapis navrzenych splatek a převod na Spending účet. V
defaultnim rezimu neni akce dostupna.

Splátku lze ve wizardu odlozit. `POST /api/income-plan/deferred-debt-payment`
pricte novou splatku k uzivatelovu odlozenemu zustatku. Pri pristim prijmu se
odlozena cast nejdriv odecte od zadaneho kapitalu a cela se priradi dluhum;
procentni profil rozdeli az zbytek. Po uspesnem zapisu splatek ji endpoint
`POST /api/income-plan/deferred-debt-payment/consume` odecte. Oba endpointy
vyzaduji ocekavanou aktualni hodnotu, aby opakovany nebo soubezny pozadavek
castku omylem nepricetl ani neodecetl dvakrat.

Uzivatel muze cely odlozeny zustatek rucne odstranit tlacitkem pod vstupem
kapitalu. Klient vola `DELETE /api/income-plan/deferred-debt-payment` s
ocekavanou aktualni hodnotou; anonymni defaultni rezim tuto akci nenabizi.

Planovane splatky se rezervuji jen tehdy, kdyz zadany prijem pokryje jejich cely
soucet. Pri nizsim prijmu se ignoruji. Pri dostatecnem prijmu se zapocitaji do
procentni alokace na dluhy a pouze rozdil do cilove dluhove castky se navrhne jako
predcasna splatka. Pokud planovane splatky cilovou dluhovou castku prevysi, snizi
alokaci BTC a Cash v jejich vzajemnem pomeru, aby zustala cela rezerva kryta.
Pokud planovane splatky existuji, hlavni karta Dluhy zobrazi zvlast pravidelnou
rezervu a zvlast vypoctene predcasne splatky. Bez planovanych splatek zustava
puvodni jednoradkove zobrazeni.

Spending krok ve workflow umi lokalne vygenerovat ceskou QR Platbu. Pouziva ucet
dekodovany z dodanych vzoru, vypočtenou částku na běžné výdaje, menu CZK a aktualni datum;
SPD payload ani bankovni udaje se neposilaji externi QR sluzbe.

Spending účet slouží k běžným výdajům. Po potvrzení odeslání vkladu na Coinmate se uzamkne kapitál i podklady celého rozpracovaného plánu; před potvrzením se částky průběžně přepočítávají.

Rozpracovaný příjem se ukládá do sessionStorage pod klíčem domácnosti a uživatele.
Refresh nebo návrat do workflow ve stejném panelu obnoví původní částky, provedené
kroky, sledování Coinmate a idempotency klíče. Dokončený běh zůstává dostupný se
souhrnem až do akce Nový příjem. Zavření panelu či vymazání úložiště není trvalá
historie příjmů a obnova mezi zařízeními není podporována.

Nulové BTC, předčasné splátky a Spending se přeskakují. VWCE krok pouze potvrzuje
vyčlenění peněz; skutečný nákup a čerpání poolu zůstávají v tabu VWCE. Souhrn tyto
částky označuje jako vyčleněné, nikoli nakoupené.

Úpravy odložených splátek přijímají volitelný Idempotency-Key. Klient jej ukládá
před odesláním. Opakování stejné operace vrací původní výsledek atomicky uložený
s úpravou zůstatku; stejný klíč s jinými parametry server odmítne.
