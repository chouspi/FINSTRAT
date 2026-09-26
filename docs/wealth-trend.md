# Projekce jmění

Projekce v Jmění → Trend používá posledních 365 dní úplných záznamů vlastního
portfolia. Neimportuje očekávané výnosy ani historii cizího indexu.

## Přítoky po dnech

Změny množství BTC a VGLA oceňuje průměrem cen na začátku a konci intervalu.
Jde o odhad čistého přítoku do sledovaných aktiv, nikoli o přesný bankovní výpis.
Převody mezi sledovanými aktivy se vzájemně kompenzují. Obchody uvnitř jednoho
intervalu nelze ze snapshotů přesně rekonstruovat.

Mezi sousedními denními záznamy známe denní přítok včetně nuly. Pokud mezi záznamy
chybí několik dní, rozdělíme změnu rovnoměrně; tyto dopočtené dny nepoužíváme
jako důkaz konkrétního dne výplaty. Chybné intervaly se nepovažují za nulový přítok.

Model porovnává denní průměr s profily pro dny v týdnu a dny v měsíci. Konce
měsíců se párují i přes různé délky měsíců. Průměry mají váhy s poločasem 90 dní;
profil každého dne má navíc váhu jednoho průměrného dne proti přeučení.

Týdenní model potřebuje nejméně 14 známých dní pro trénink a dalších 14 pro
ověření, měsíční 60 + 30. Každou ověřovanou hodnotu předpovídá výhradně z
předchozích dat. Rytmus se použije pouze při alespoň 10% zlepšení vážené
kvadratické chyby oproti dennímu průměru; jinak zůstane denní model.

Vklady a výběry se modelují odděleně, takže se jejich načasování neztratí ani
při nulovém součtu. Kalendářní profil je normalizován přes dalších 365 dní,
aby samotné rozložení plateb nezvyšovalo odhad průměrného tempa.
Tempo posledních 30 dní postupně přechází k váženému dlouhodobému průměru
s poločasem 90 dní. Krátkodobé zrychlení se tedy neprodlužuje donekonečna.

## Výnos, dluhy a graf

Historický výnos se od změn hodnoty portfolia odděluje odečtením přítoku
s předpokladem toku uprostřed intervalu (Modified Dietz). Denní logaritmické
výnosy se váží podle stáří a promítají složeně. Přítoky a výnos mají nezávislé
podmínky použitelnosti: nejméně 30 dní a poslední použitelný interval ne starší
než 30 dní vůči poslednímu snapshotu. Nedostatek historie výnosu nevypíná přítoky.

Projekce obsahuje každý kalendářní den až do zvoleného horizontu. Denní přítok
se započítá uprostřed dne, výběr nejvýše do hodnoty portfolia. Naplánované splátky
snižují spotřebitelský dluh v příslušný den, nejvýše k nule. Předpokládají se
splátky z prostředků mimo sledované portfolio; hypotéka není součástí čistého
jmění v tomto grafu.

Zobrazený měsíční přítok je součet modelovaných čistých toků příštího roku dělený
12. Není to pevný měsíční vklad; skutečně uplatněné výběry může omezit vyčerpání
portfolia. Přepnutí horizontu zachovává stejné denní hodnoty společné části.
