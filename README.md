# IFC Optimizer — BIM Engine

Krymper IFC-filer utan att förstöra modellen. Allt arbete sker lokalt i
webbläsaren — **ingen modell laddas upp någonstans**, vilket är hela poängen
jämfört med webbtjänster som bimcamel.com. Filen du hämtar är ett enda
fristående HTML-dokument utan beroenden.

Repot innehåller två verktyg som delar samma motor:

| | |
|---|---|
| **[IFC Optimizer](https://adrianduveholtbe.github.io/ifc-optimizer/)** | krymper filen du redan har |
| **[IFC Diagnos](https://adrianduveholtbe.github.io/ifc-optimizer/diagnos/)** | talar om *varför* den är stor och vad du ändrar i Revits exportinställningar |

## Kör den

**→ [adrianduveholtbe.github.io/ifc-optimizer](https://adrianduveholtbe.github.io/ifc-optimizer/)**

Sidan är bara ett skal — dina filer läses av webbläsaren på din egen dator och
skickas aldrig till någon server. Vill du köra den helt utan nät: högerklicka
och spara sidan, eller klona repot och öppna `index.html`. Öppnad direkt från
disk kör motorn i huvudtråden i stället för i en bakgrundstråd (Chrome tillåter
inte `new Worker(blob:)` från `file://`), så gränssnittet står stilla medan en
stor modell arbetas igenom. Via en URL eller `tools/devserver.py` slipper du det.

## Bygga

`index.html` är genererad — **redigera den aldrig direkt**, all källkod ligger i
`src/`.

```bash
python build.py             # -> index.html
python build.py --install   # kopierar dessutom till en intern mapp,
                            # styrs av IFC_OPT_INSTALL_DIR
```

## Vad verktyget gör

| Steg | Vad som händer |
|---|---|
| Läsning | STEP/SPF-läsare på byte-nivå. Bygger inga strängar av filen, så 100–300 MB-modeller går att hantera i en webbläsare. |
| FPR | Avrundar flyttal i punkter, punktlistor, profiler och extrusioner till valfri tolerans (0,1 / 0,01 / 0,001 mm). Revit skriver ofta 11–16 decimaler i millimetermodeller. |
| Borttagning | Egenskaper, mängder, typobjekt, material, stilar, lager, klassificering, anslutningsrelationer, 2D-representationer, rutnät, rum, öppningar, valda byggdelsklasser. |
| Reparation | Varje borttagning lagas i referensgrafen: listor rensas, valfria attribut nollas, relationer som blir tomma dör. Det vi inte förstår **återuppstår** i stället, så filen kan aldrig bli ogiltig. |
| Skräpsamling | Allt som inte nås från ett rotobjekt (IfcRoot) tas bort. Skyddsnät: hittas inte IfcProject som rotobjekt hoppas skräpsamlingen över helt. |
| Koplanär sammanslagning | Trianglar i samma plan smälts till en yta med hål där det behövs. Förlustfritt — varje plangrupp areakontrolleras och lämnas orörd om summan inte stämmer. |
| Dubbletter | Rekursiv sammanslagning underifrån och uppåt till fixpunkt (samma idé som IfcToolbox' RE-strategi). Rotobjekt med GlobalId slås aldrig ihop. |
| Tessellering | Svetsning av `IfcCartesianPointList3D` med omräkning av indexlistor, borttagning av urartade trianglar. |
| Lådor | Aggressivt läge kan byta mesh/BREP mot en extruderad omslutande låda. |
| Utskrift | Numrerar om instanserna, skriver ny fil, valfritt som `.ifczip`. |
| Kontroll | Läser om resultatet och verifierar att varje referens pekar på ett objekt som finns. Brutna referenser som redan fanns i originalet redovisas separat. |

## Snabbläge för mycket stora filer

Hela optimeringen bygger på ett instansindex och en referensgraf i minnet.
Kostnaden växer med antalet instanser, och över ungefär **600 MB** ryms det
inte i en webbläsarflik. Då kopplas **snabbläget** in automatiskt
(`forceStream` tvingar det): filen läses i 32 MB-bitar och skrivs ut i bitar,
utan index och utan graf. Bara sådant som är säkert utan att känna hela
modellen görs:

* avrundning av flyttal i geometrityperna (FPR)
* `#12= IFCX(` normaliseras till `#12=IFCX(`
* valfri ifczip-packning

Instansnumren rörs aldrig, så referenserna kan per konstruktion inte gå
sönder — det är verifierat: efter en körning på 166 MB är alla 3 126 884
instansnummer identiska i samma ordning, med noll brutna referenser.
Minnesåtgången är konstant oavsett filstorlek, eftersom utdatat läggs i
Blob-delar som webbläsaren kan sidväxla till disk.

Mätt på samma 166 MB-modell: 150,5 MB rå (−9,5 %, enbart avrundningen) eller
**27,5 MB som ifczip (−83,5 %)** på 30 sekunder. En 1,8 GB-fil landar alltså
på i storleksordningen 300 MB som ifczip.

Enheten läses ur början av DATA-sektionen. Hittas ingen längdenhet avrundas
ingenting — fel enhetsantagande skulle betyda fel tolerans.

## Mätt på en riktig modell

166 MB IFC2X3 från Revit (stommodell, 3,13 milj. instanser, mm-enheter):

| Nivå | Efter | Vinst | Tid |
|---|---|---|---|
| Lätt | 108,8 MB | 34,6 % | ~6 s |
| Medel | 89,1 MB | 46,5 % | ~13 s |
| Aggressiv (.ifczip) | 16,5 MB | 90,1 % | ~9 s |

Samma modell i snabbläge: 27,5 MB (90,1 % → 83,5 %, alltså sämre än full
optimering, men läget finns för filer som inte går att optimera fullt ut).

Alla tre kontrollerade: 0 brutna referenser, alla byggdelar kvar
(6 886 IfcMember, 400 IfcColumn, 485 IfcBeam, 268 väggar, 462 öppningar …),
och varje kvarvarande skal har samma form som före — största formavvikelse
0,016 % och den kommer enbart från koordinatavrundningen på de minsta
detaljerna.

## IFC Diagnos

Optimizern åtgärdar symtomet i efterhand. Diagnosen letar upp orsaken i
exporten, så att nästa fil blir mindre från början.

Den bokför varje geometriinstans på **den byggdel och den representationsform
som äger den** — delad geometri räknas en gång, så summan överstiger aldrig
filen. Ur det faller tabellen som brukar avslöja allt: *byte per objekt* per
klass. På teststommodellen väger en `IfcColumn` 232 kB och en `IfcBeam` 104 kB,
medan en `IfcMember` väger 737 B. 885 pelare och balkar bär alltså 140 MB av
166, för att de exporterats som BREP i stället för svepta solider.

Dessutom grupperas egenskapsuppsättningarna på namn med sin verkliga kostnad
(`Pset_MemberCommon` 1,8 MB, `Pset_QuantityTakeOff` 753 kB …), och varje fynd
kopplas till den kryssruta i Revits IFC-export som styr det.

**Ladda upp exportuppsättningen** (Revit → Export → IFC → *Modify setup* →
spara) så läses dina 46 inställningar in och jämförs med vad som faktiskt
ligger i filen. Då står det inte bara "egenskaper kostar 2,9 MB" utan
"*Export IFC common property sets* står på PÅ och kostar 2,9 MB".

Rapporten skiljer på tre sorters vinst — förlustfritt, sällan använd metadata,
och sådant som kräver ett beslut — plus en fjärde post för geometri som ingen
kryssruta rår på utan som måste göras om i modellen. Posterna överlappar
annars varandra och en enkel summa blir större än filen.

Diagnosen kräver hela referensgrafen och därmed hela filen i minnet. Över
gränsen (samma 600 MB som optimeraren) körs en förenklad diagnos: bara
inställningarna och filens grova fördelning granskas. Ett urval av de första
megabyten duger inte till mer — en IFC är inte homogen, geometrin ligger först
och egenskaperna sist.

## Struktur

```
src/engine/    motorn, en fil per steg, konkateneras i namnordning
  00-util      byte-hjälp, talformat, CRC32, ZIP-läsning/skrivning
  05-options   inställningar + förinställningar (delas med gränssnittet)
  10-parse     instansindex, referensgraf
  20-types     IFC-kunskapen: kategorier, borttagningsregler, reparationsåtgärder
  30-strip     borttagning, reparation, skräpsamling
  40-emit      gemensam attribututskrift (hash + fil använder samma kod)
  50-dedup     rekursiv dubblettsammanslagning
  60-geom      koordinatcache, koplanär sammanslagning
  62-tess      svetsning av punktlistor, omslutande lådor
  70-write     omnumrering, utskrift, omläsningskontroll
  75-analyse   storleksrapport
  76-advise    djupanalys: vems byten, vilken form, vad varje Pset kostar
  78-rules     fynd -> orsak -> åtgärd, kopplat till Revits kryssrutor
  80-api       körschema
  90-worker    meddelanden i webbarbetaren
  06-revit     Revits 46 exportinställningar (delas med gränssnittet)
src/ui/        IFC Optimizer: index.html, app.css, app.js, logo.txt
src/diag/      IFC Diagnos: index.html, app.js, extra.css
tools/         make_sample.py, make_edge.py, verify.py, area_check.py, devserver.py
test/          genererade testfiler + harness.html
```

## Testning

```bash
python tools/make_sample.py     # syntetiska testfiler (ingen kunddata)
python tools/make_edge.py       # elak fil: kommentarer, flerradiga instanser,
                                # \X2\-escapes, trasig referens, korta GlobalId
python tools/devserver.py       # http://localhost:8127
```

Öppna sedan `http://localhost:8127/test/harness.html?suite=1`. Testriggen kör
13 kombinationer av filer och nivåer och POST:ar resultatet till `test/out/`.
Verifiera därefter oberoende, i Python:

```bash
python tools/verify.py test/sample_2x3.ifc test/out/suite_2x3_medel.ifc
python tools/verify.py --refs-only test/out/big_medel.ifc
python tools/area_check.py fore.ifc efter.ifc
```

`verify.py` kontrollerar syntax, brutna referenser, dubblerade instansnummer,
tomma obligatoriska listor och attributformen för ett fyrtiotal vanliga klasser,
samt vilka rotobjekt som försvunnit. `area_check.py` jämför mantelyta och volym
skal för skal — det är det som bevisar att den koplanära sammanslagningen är
förlustfri.

Stora modeller testas via `/big/<filnamn>` i devservern, som pekar på
`IFC_BIG_DIR` (standard: Dokument-mappen). Kundmodeller ska aldrig kopieras
in i det här repot.

## Referenser

* [bimcamel.com/reduce-ifc-file-size](https://bimcamel.com/reduce-ifc-file-size) —
  serverbaserad tjänst med tre nivåer. Kräver uppladdning, därför inte
  användbar för kundmodeller.
* [youshengCode/IfcToolbox](https://github.com/youshengCode/IfcToolbox) (GPL-3.0,
  C#/Xbim) — dess optimizer gör FPR + rekursiv dubblettsammanslagning. Vi har
  tagit metoden, inte koden: den här motorn är skriven från grunden i JS, delar
  ingen kod med IfcToolbox och är alltså inget derivat av den.

## Upphovsrätt

© BIM Engine AB. Koden ligger öppet för att den ska vara enkel att komma åt och
granska, men den är inte släppt som fri programvara — hör av dig om du vill
använda den i något eget.

