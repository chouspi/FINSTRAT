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
nakupu, hromadny zapis navrzenych splatek a informativni cash rezervu. V
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
soucet. Pri nizsim prijmu se ignoruji. Pri dostatecnem prijmu se rezerva nejprve
odecte od zakladu a nasledne snizi beznou procentni alokaci do dluhu. Takto
uvolnena cast se prerozdeli mezi BTC a Cash v jejich vzajemnem pomeru, aby po
provedeni navrzenych prevodu zustala na uctu presne cela rezerva.
Pokud planovane splatky existuji, hlavni karta Dluhy zobrazi zvlast pravidelnou
rezervu a zvlast vypoctene predcasne splatky. Bez planovanych splatek zustava
puvodni jednoradkove zobrazeni.

Cash krok ve workflow umi lokalne vygenerovat ceskou QR Platbu. Pouziva ucet
dekodovany z dodanych vzoru, vypoctenou Cash castku, menu CZK a aktualni datum;
SPD payload ani bankovni udaje se neposilaji externi QR sluzbe.
