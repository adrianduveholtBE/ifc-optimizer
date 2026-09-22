/* ==========================================================================
   78-rules.js  ·  från mätning till åtgärd
   --------------------------------------------------------------------------
   Varje regel tittar på analysen, och om den hittar något tungt talar den om
   vad det är, varför det ligger i filen och vilken kryssruta i Revits
   IFC-export som styr det. Tabellerna finns i 06-revit.js.
   ========================================================================== */

function cfgGet(cfg, key) {
  if (!cfg || !cfg.raw) return undefined;
  const v = cfg.raw[key];
  return v === null ? undefined : v;
}

/* --------------------------------------------------------------------------
   Reglerna. Varje regel returnerar null eller ett fynd.
   forlust: 'ingen' = informationen finns kvar i modellen/går att få tillbaka
            'metadata' = du tappar information som sällan används nedströms
            'ja' = du tappar något någon kan behöva
   -------------------------------------------------------------------------- */
function buildFindings(rep, diag, cfg) {
  const total = rep.bytes || 1;
  const F = [];
  const add = function (f) {
    if (!f) return;
    f.bytes = Math.round(f.bytes || 0);
    f.share = f.bytes / total;
    /* sparbart = vad du faktiskt får tillbaka. För geometri som behöver
       göras om i modellen är det inte samma sak som vikten. */
    f.sparbart = (f.sparbart === undefined) ? f.bytes : Math.round(f.sparbart);
    if (f.bytes > 0 || f.always) F.push(f);
  };
  const psetBytes = function (pred) {
    let b = 0, c = 0;
    for (const p of (diag.psets || [])) {
      if (p.kind === 'relationer') continue;
      if (pred(p.name, p.kind)) { b += p.bytes; c += p.count; }
    }
    return { bytes: b, count: c };
  };

  /* --- 1. zippa filen: alltid möjligt, alltid förlustfritt --------------- */
  const ft = cfgGet(cfg, 'IFCFileType');
  add({
    id: 'zip',
    titel: 'Spara som zippad IFC',
    bytes: Math.round(total * 0.87),
    always: true,
    vad: 'IFC är ren text och komprimerar extremt bra — typiskt 85–90 procent.',
    orsak: ft === undefined
      ? 'Filen är sparad okomprimerad.'
      : (ft === 0 ? 'Exporten står på okomprimerad IFC.' : 'Exporten står redan på ' + (FILE_TYPES[ft] || ft) + '.'),
    atgard: ft === 2 || ft === 3
      ? 'Redan inställt — inget att göra.'
      : 'Sätt File type till "Zipped IFC" i exporten, eller kör filen genom IFC Optimizer. ' +
        'Solibri, Navisworks och de flesta visare läser .ifczip; kontrollera bara att mottagaren gör det.',
    installning: 'IFCFileType',
    börVara: 2,
    forlust: 'ingen',
    klar: ft === 2 || ft === 3
  });

  /* --- 2. Revits egna parametrar ---------------------------------------- */
  const revit = psetBytes(function (n, k) { return k === 'egenskaper' && isRevitPset(n); });
  if (revit.bytes > total * 0.005) {
    add({
      id: 'revit-psets',
      titel: 'Revits egna parameteruppsättningar',
      bytes: revit.bytes,
      vad: fmtNum(revit.count) + ' uppsättningar med Revits interna parametergrupper (Constraints, Other, Identity Data …).',
      orsak: 'Inställningen "Export Revit property sets" dumpar alla Revit-parametrar till IFC.',
      atgard: 'Stäng av den. Behöver mottagaren enstaka parametrar är en egen Pset-fil ' +
              '("Export user defined property sets") mycket billigare och tydligare.',
      installning: 'ExportInternalRevitPropertySets',
      börVara: false,
      forlust: 'metadata'
    });
  }

  /* --- 3. standardiserade Pset ------------------------------------------ */
  const common = psetBytes(function (n, k) { return k === 'egenskaper' && !isRevitPset(n) && isCommonPset(n); });
  if (common.bytes > total * 0.01) {
    add({
      id: 'common-psets',
      titel: 'Standardiserade egenskapsuppsättningar (Pset_…)',
      bytes: common.bytes,
      vad: fmtNum(common.count) + ' uppsättningar av buildingSMART-typ.',
      orsak: '"Export IFC common property sets" är påslaget.',
      atgard: 'Behåll om leveransen kravställer egenskaper — det är de här som är standard. ' +
              'Ska filen bara användas för samordning kan de stängas av.',
      installning: 'ExportIFCCommonPropertySets',
      börVara: true,
      forlust: 'ja'
    });
  }

  /* --- 4. mängder -------------------------------------------------------- */
  const qty = psetBytes(function (n, k) { return k === 'mängder'; });
  if (qty.bytes > total * 0.003) {
    add({
      id: 'quantities',
      titel: 'Mängder (BaseQuantities)',
      bytes: qty.bytes,
      vad: fmtNum(qty.count) + ' mängduppsättningar med areor, volymer och längder.',
      orsak: '"Export base quantities" är påslaget.',
      atgard: 'Stäng av om ingen mängdar på modellen. Mängderna går alltid att räkna fram ur geometrin igen.',
      installning: 'ExportBaseQuantities',
      börVara: false,
      forlust: 'metadata'
    });
  }

  /* --- 5. egna Pset ------------------------------------------------------ */
  const own = psetBytes(function (n, k) { return k === 'egenskaper' && !isRevitPset(n) && !isCommonPset(n); });
  if (own.bytes > total * 0.01) {
    add({
      id: 'user-psets',
      titel: 'Egna egenskapsuppsättningar',
      bytes: own.bytes,
      vad: fmtNum(own.count) + ' uppsättningar som varken är Revits egna eller buildingSMART-standard.',
      orsak: 'De kommer från "Export user defined property sets" eller från scheman ("Export schedules as property sets").',
      atgard: 'Gå igenom din Pset-fil och ta bort det ingen efterfrågar. Listan nedan visar vad varje uppsättning kostar.',
      installning: 'ExportUserDefinedPsets',
      forlust: 'ja'
    });
  }

  /* --- 6. rumsavgränsningar --------------------------------------------- */
  const sb = diag.counts.spaceBoundaries;
  const sbSetting = cfgGet(cfg, 'SpaceBoundaries');
  if (sb.count > 0) {
    add({
      id: 'space-boundaries',
      titel: 'Rumsavgränsningar (IfcRelSpaceBoundary)',
      bytes: sb.bytes,
      vad: fmtNum(sb.count) + ' avgränsningar mellan rum och omgivande byggdelar.',
      orsak: 'Space boundaries står på ' +
             (sbSetting === undefined ? '1st eller 2nd level' : (SPACE_BOUNDARY_LEVELS[sbSetting] || sbSetting)) + '.',
      atgard: 'Sätt Space boundaries till "None" om filen inte ska användas för energiberäkning. ' +
              'Det här är en av de största enskilda posterna i arkitektmodeller.',
      installning: 'SpaceBoundaries',
      börVara: 0,
      forlust: 'ja'
    });
  }

  /* --- 7. rum ------------------------------------------------------------ */
  const spaceGeom = (diag.classes || []).filter(function (c) { return c.cls === 'IFCSPACE'; })
                                        .reduce(function (s, c) { return s + c.bytes; }, 0);
  if (diag.counts.spaces.count > 0) {
    add({
      id: 'spaces',
      titel: 'Rum (IfcSpace)',
      bytes: diag.counts.spaces.bytes + spaceGeom,
      vad: fmtNum(diag.counts.spaces.count) + ' rum med volymgeometri.',
      orsak: '"Export rooms, areas and spaces in 3D views" är påslaget.',
      atgard: 'Stäng av för rena samordningsmodeller. Behövs rummen kan "Use 2D room boundaries for room volume" ' +
              'ge enklare rumskroppar.',
      installning: 'ExportRoomsInView',
      börVara: false,
      forlust: 'ja'
    });
  }

  /* --- 8. 2D-representationer ------------------------------------------- */
  const axis = (diag.idents || []).filter(function (i) {
    const u = String(i.ident).toUpperCase();
    return u === 'AXIS' || u === 'FOOTPRINT' || u === 'ANNOTATION' || u === 'PROFILE';
  });
  const axisBytes = axis.reduce(function (s, i) { return s + i.bytes; }, 0) + diag.counts.annotations.bytes;
  if (axisBytes > total * 0.003) {
    add({
      id: 'twod',
      titel: '2D-geometri (Axis, FootPrint, annotation)',
      bytes: axisBytes,
      vad: axis.map(function (i) { return i.ident + ' ' + fmtNum(i.reps) + ' st'; }).join(', ') +
           (diag.counts.annotations.count ? ', ' + fmtNum(diag.counts.annotations.count) + ' IfcAnnotation' : ''),
      orsak: 'Axis- och FootPrint-kurvor skriver Revit automatiskt för väggar, balkar och pelare. ' +
             'IfcAnnotation kommer från "Export 2D plan view elements".',
      atgard: 'Stäng av "Export 2D plan view elements". Axis/FootPrint styrs inte av någon kryssruta — ' +
              'de plockas bort av IFC Optimizer i stället.',
      installning: 'Export2DElements',
      börVara: false,
      forlust: 'metadata'
    });
  }

  /* --- 9. omslutande lådor ---------------------------------------------- */
  const box = (diag.idents || []).find(function (i) { return String(i.ident).toUpperCase() === 'BOX'; });
  if (box || diag.counts.boundingBox.count) {
    add({
      id: 'bbox',
      titel: 'Omslutande lådor (Box-representationer)',
      bytes: (box ? box.bytes : 0) + diag.counts.boundingBox.bytes,
      vad: fmtNum(box ? box.reps : diag.counts.boundingBox.count) + ' extra lådor utöver den riktiga geometrin.',
      orsak: '"Export bounding box" är påslaget.',
      atgard: 'Stäng av. Nästan ingen visare använder dem.',
      installning: 'ExportBoundingBox',
      börVara: false,
      forlust: 'metadata'
    });
  }

  /* --- 10. geometriformen ------------------------------------------------ */
  const forms = diag.forms || [];
  const formBytes = function (name) {
    const f = forms.find(function (x) { return String(x.rtype).toLowerCase() === name; });
    return f ? f.bytes : 0;
  };
  const brep = formBytes('brep') + formBytes('advancedbrep');
  const swept = formBytes('sweptsolid') + formBytes('clipping');
  const tess = formBytes('tessellation');
  const geomTotal = brep + swept + tess + formBytes('mappedrepresentation') + formBytes('csg') || 1;

  if (brep > total * 0.10) {
    const solidRep = cfgGet(cfg, 'ExportSolidModelRep');
    add({
      id: 'brep',
      titel: 'Geometrin exporteras som BREP i stället för svepta solider',
      bytes: brep,
      vad: fmtPct(brep / geomTotal) + ' av geometrin är facetterad BREP — varje yta, kant och hörn skrivs ut var för sig. ' +
           'En extrusion tar en bråkdel av utrymmet.',
      orsak: solidRep === true
        ? '"Allow use of mixed \'Solid Model\' representation" är påslaget, vilket låter Revit falla tillbaka på BREP.'
        : 'Revit klarar inte att beskriva geometrin som extrusion. Vanliga orsaker: in-place-familjer, ' +
          'importerad CAD- eller SAT-geometri, många void-cuts, eller kroppar som skurits av ' +
          'andra element.',
      atgard: 'Titta i tabellen över byggdelsklasser nedan — den visar vilka klasser som bär BREP-byten. ' +
              'Åtgärda i modellen: ersätt in-place-familjer med laddbara familjer, ta bort importerad ' +
              'geometri, och undvik onödiga void-cuts. Stäng även av "Allow use of mixed \'Solid Model\' ' +
              'representation" om den är på.',
      installning: 'ExportSolidModelRep',
      börVara: false,
      forlust: 'ingen',
      sparbart: 0,
      kraverModellarbete: true
    });
  }

  if (tess > total * 0.05 && diag.tess) {
    const lod = cfgGet(cfg, 'TessellationLevelOfDetail');
    add({
      id: 'tessellation',
      titel: 'Tessellerad geometri (mesh)',
      bytes: tess,
      vad: fmtNum(diag.tess.points) + ' punkter i ' + fmtNum(diag.tess.sets) + ' mesh-kroppar, ' +
           'i snitt ' + fmtNum(Math.round(diag.tess.pointsPerSet)) + ' punkter per kropp.',
      orsak: lod === undefined
        ? 'Detaljnivån för mesh-geometri styr hur tätt krökta ytor delas upp.'
        : 'Level of detail står på ' + lod + ' (0 = grövst, 1 = finast).',
      atgard: 'Sänk "Level of detail for some element geometry" ett steg och exportera om — ' +
              'mät skillnaden här. Räcker IFC2x3 för mottagaren ger det ofta mindre filer än ' +
              'IFC4 Reference View, som tessellerar mer. Stäng även av "Keep tessellated geometry ' +
              'as triangulation" om den är på.',
      installning: 'TessellationLevelOfDetail',
      forlust: 'ja'
    });
  }

  /* --- 11. dubbletter och precision: hanteras inte av Revit -------------- */
  if (diag.duplicates && diag.duplicates.bytes > total * 0.02) {
    add({
      id: 'duplicates',
      titel: 'Identiska objekt som skrivs ut flera gånger',
      bytes: diag.duplicates.bytes,
      vad: 'Minst ' + fmtNum(diag.duplicates.count) + ' instanser är exakta kopior av något annat i filen ' +
           '(punkter, riktningar, profiler, hela geometrigrenar).',
      orsak: 'Revit skriver ut geometrin per objekt utan att återanvända det som är lika.',
      atgard: 'Ingen exportinställning rår på det här — kör filen genom IFC Optimizer, som slår ihop dem. ' +
              'Siffran är ett golv: den verkliga vinsten blir större när sammanslagningen körs i flera varv.',
      installning: null,
      forlust: 'ingen'
    });
  }

  if (rep.round && rep.round.saving > total * 0.02) {
    add({
      id: 'precision',
      titel: 'Onödigt många decimaler i koordinaterna',
      bytes: rep.round.saving,
      vad: 'Flyttal skrivs med upp till ' + rep.round.maxDecimals + ' decimaler. I en ' + rep.unit.label +
           '-modell är allt bortom ett par decimaler brus.',
      orsak: 'Revit skriver ut full dubbelprecision. Det går inte att ställa om i exporten.',
      atgard: 'Kör filen genom IFC Optimizer med 0,01 mm precision. Det är förlustfritt i praktiken — ' +
              'hundra gånger finare än byggtoleransen.',
      installning: null,
      forlust: 'ingen'
    });
  }

  /* --- 12. instansiering ------------------------------------------------- */
  if (diag.instancing && diag.instancing.totalReps > 200 && diag.instancing.share < 0.25) {
    add({
      id: 'instancing',
      titel: 'Geometrin återanvänds inte mellan lika objekt',
      bytes: 0,
      always: true,
      vad: 'Bara ' + fmtPct(diag.instancing.share) + ' av representationerna är av typen MappedRepresentation, ' +
           'alltså delad geometri. Resten skriver ut sin kropp från grunden.',
      orsak: 'Det händer när familjer är in-place, när "Export parts as building elements" är påslaget, ' +
             'eller när objekt skurits individuellt så att de inte längre är lika.',
      atgard: 'Använd laddbara familjer i stället för in-place, och stäng av "Export parts as building elements" ' +
              'om delarna inte behövs. Varje typ som kan delas sparar hela sin geometri gånger antalet instanser.',
      installning: 'ExportPartsAsBuildingElements',
      börVara: false,
      forlust: 'ingen',
      sparbart: 0,
      kraverModellarbete: true
    });
  }

  /* --- 13. sådant som bara syns i inställningarna ------------------------ */
  if (cfg) {
    if (cfgGet(cfg, 'VisibleElementsOfCurrentView') === false) {
      add({
        id: 'visible-only',
        titel: 'Hela modellen exporteras, inte bara det som syns',
        bytes: 0, always: true,
        vad: '"Export only elements visible in view" är avstängt.',
        orsak: 'Då följer allt med, även det som är dolt eller ligger utanför den vy du exporterar.',
        atgard: 'Skapa en 3D-vy som innehåller precis det mottagaren ska ha, och slå på inställningen. ' +
                'Det är den grövsta och mest effektiva spaken av alla.',
        installning: 'VisibleElementsOfCurrentView',
        börVara: true,
        forlust: 'ja'
      });
    }
    if (cfgGet(cfg, 'ExportLinkedFiles') === true) {
      add({
        id: 'links',
        titel: 'Länkade modeller exporteras med',
        bytes: 0, always: true,
        vad: '"Export linked files as separate IFCs" är påslaget.',
        orsak: 'Varje länk blir en egen IFC — sammanlagt mycket data, ofta sådant mottagaren redan har.',
        atgard: 'Stäng av om mottagaren får länkarna på annat håll.',
        installning: 'ExportLinkedFiles',
        börVara: false,
        forlust: 'ja'
      });
    }
    if (cfgGet(cfg, 'SplitWallsAndColumns') === true) {
      add({
        id: 'split',
        titel: 'Väggar och pelare delas per våning',
        bytes: 0, always: true,
        vad: '"Split walls, columns, ducts by level" är påslaget.',
        orsak: 'Ett objekt över tre våningar blir tre objekt med var sin geometri, egenskaper och relationer.',
        atgard: 'Stäng av om inte mottagaren kräver våningsvis uppdelning.',
        installning: 'SplitWallsAndColumns',
        börVara: false,
        forlust: 'ja'
      });
    }
    if (cfgGet(cfg, 'ExportSchedulesAsPsets') === true) {
      add({
        id: 'schedules',
        titel: 'Scheman exporteras som egenskaper',
        bytes: 0, always: true,
        vad: '"Export schedules as property sets" är påslaget.',
        orsak: 'Varje schema blir en egenskapsuppsättning på varje objekt det omfattar.',
        atgard: 'Stäng av, eller kryssa "Export only schedules containing IFC, Pset or Common in the title" ' +
                'så att bara avsedda scheman följer med.',
        installning: 'ExportSchedulesAsPsets',
        börVara: false,
        forlust: 'ja'
      });
    }
  }

  F.sort(function (a, b) { return b.bytes - a.bytes; });
  return F;
}

/* Summera vad som går att spara utan att tappa något. */
function summariseFindings(findings, totalBytes) {
  let lossless = 0, meta = 0, lossy = 0, rework = 0;
  for (const f of findings) {
    if (f.id === 'zip') continue;             // räknas separat, den multiplicerar allt annat
    if (f.kraverModellarbete) { rework += f.bytes; continue; }
    if (f.forlust === 'ingen') lossless += f.sparbart;
    else if (f.forlust === 'metadata') meta += f.sparbart;
    else lossy += f.sparbart;
  }
  return { lossless: lossless, meta: meta, lossy: lossy, rework: rework, total: totalBytes };
}
