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
Predcasna cast se omezuje az souctem zustatku vsech aktivnich spotrebitelskych
dluhu vcetne dluhu s prioritou 0; planovane splatky se od tohoto limitu znovu
neodecitaji. Mezi jednotlive dluhy se castka dale deli podle jejich priorit.
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

Nulové BTC, předčasné splátky a Spending se přeskakují. VGLA krok pouze potvrzuje
vyčlenění peněz; skutečný nákup a čerpání poolu zůstávají v tabu VGLA. Souhrn tyto
částky označuje jako vyčleněné, nikoli nakoupené.

Úpravy odložených splátek přijímají volitelný Idempotency-Key. Klient jej ukládá
před odesláním. Opakování stejné operace vrací původní výsledek atomicky uložený
s úpravou zůstatku; stejný klíč s jinými parametry server odmítne.

## Serverove API nakupy Coinmate

`POST /api/income-plan/coinmate-bitcoin-purchase` se stabilnim `Idempotency-Key`
uklada trvalou ulohu do PostgreSQL. Telo obsahuje `amountCzk`, volitelne
`accountId` vlastniho uctu Coinmate a `waitForDeposit` (vychozi `false`).
Income posila `waitForDeposit: true` az po kliknuti na **Odeslano**. Server v te
chvili nacte CZK zustatek a vyzaduje jeho narust o celou ocekavanou castku.
Pro sledovani pouziva normalizovany zustatek (`funding_balance/czk`): skutecny
CZK zustatek plus skutecne debety vsech maker nakupu controlleru. Vlastni
souběžny API nakup tak neskryje pripis dalsiho vkladu. Controller overuje
stabilitu snapshotu zustatku a plneni pred vracenim hodnoty.
Pouhe otevreni QR formulare sledovani ani nakup nespousti. Kontrola zustatku
neni identifikace konkretni bankovni platby; externi obchody nebo vybery mohou
rozpoznani vkladu oddalit. Vice cekajicich vkladu ma kumulativni cil, aby stejny
narust zustatku nepotvrdil dva vklady.

Worker po 5 sekundach obnovuje stav a po pripisu spusti controller. Ten pouziva
vyhradne `buyLimit`, `postOnly=1`, cenu jeden cenovy krok pod nejlepsi prodejni
nabidkou a kazdych 30 sekund rusi zbytek a precenuje podle aktualniho trhu
(vc. pohybu nahoru). Rozpocet zustava pevny vcetne rezervy na maker poplatek
nejvyse 0,4 %. Po zruseni musi byt potvrzen konec puvodniho prikazu vcetne
poslednich plneni, teprve potom muze vzniknout dalsi. Nejisty vysledek odeslani
se pouze dohledava; automaticke opakovani bez potvrzeni je zakazano.

`GET /api/income-plan/coinmate-purchase-requirements` poskytuje aktualni minimum
v BTC i CZK a maximalni rozpocet controlleru. Minimum pochazi z Coinmate
`tradingPairs.minAmount`, cena a presnost take z burzy; pevny limit 25 Kc neni
pouzity. Server kontroluje limit pred prijetim nove ulohy a controller znovu
pred kazdou objednavkou. Podlimitni zbytek po nakupu zustava v CZK.

`GET /api/income-plan/coinmate-bitcoin-purchases` vraci jen aktivni ulohy
aktualniho uzivatele (vcetne cekani na vklad a opakovaneho zapisu pri chybe).
BTC tab je zobrazuje pres **API nakupy**. Detail je dostupny pres
`GET /api/income-plan/coinmate-bitcoin-purchase/{id}`. Dokoncene ulohy se v
seznamu nezobrazuji, ale zustavaji v DB kvuli idempotenci a auditu.

Po dokonceni worker idempotentne vytvori BTC lot s mnozstvim a skutecnou cenou
vcetne poplatku podle jednotlivych plneni. Cena se neodvozuje z celeho rozpoctu
ani z rozdilu zustatku. Datum je cas posledniho plneni; prohlizec neprovadi
ucetni zapis. Ulozeny vysledek a stejny idempotency klic umoznuji bezpecne
zopakovat zapis po padu mezi ulozenim lotu a dokoncenim ulohy.
