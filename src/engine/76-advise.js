/* ==========================================================================
   76-advise.js  ·  djupanalys för diagnosen
   --------------------------------------------------------------------------
   Vanliga analysen (75) säger *vilka klasser* som väger. Den här säger
   *vems* byten det är: vilken byggdel geometrin hänger på, vilken
   representationsform den har, och vad varje egenskapsuppsättning kostar.
   Det är det som går att koppla till en kryssruta i exportinställningarna.
   ========================================================================== */

/* ungefärlig statementstorlek: "#id=TYP(attribut);" + radslut */
function entBytes(m, i) {
  const id = m.ids[i];
  let digits = 1, v = id;
  while (v >= 10) { v = (v - v % 10) / 10; digits++; }
  const tn = m.typeNames[m.tId[i]];
  return (m.eOff[i] - m.pOff[i]) + digits + 2 + (tn ? tn.length : 0) + 2;
}

/* Följ IfcShapeRepresentation -> IfcMappedItem -> IfcRepresentationMap ->
   den mappade representationen och returnera dess RepresentationType. */
function resolveMapped(m, rep, depth) {
  if (depth <= 0) return null;
  const tMI = m.typeIds.get('IFCMAPPEDITEM');
  const tRM = m.typeIds.get('IFCREPRESENTATIONMAP');
  if (tMI === undefined || tRM === undefined) return null;
  const ra = [];
  splitAttrs(m.buf, m.pStart(rep), m.pEnd(rep), ra);
  if (ra.length < 8) return null;
  const items = refListAt(m, ra[6], ra[7]);
  for (const it of items) {
    if (m.tId[it] !== tMI) continue;
    const ia = [];
    splitAttrs(m.buf, m.pStart(it), m.pEnd(it), ia);
    if (ia.length < 2) continue;
    const src = refAt(m, ia[0], ia[1]);
    if (src < 0 || m.tId[src] !== tRM) continue;
    const sa = [];
    splitAttrs(m.buf, m.pStart(src), m.pEnd(src), sa);
    if (sa.length < 4) continue;
    const inner = refAt(m, sa[2], sa[3]);
    if (inner < 0) continue;
    const na = [];
    splitAttrs(m.buf, m.pStart(inner), m.pEnd(inner), na);
    if (na.length < 6) continue;
    const t = quotedAt(m.buf, na[4], na[5]);
    if (t === 'MappedRepresentation') return resolveMapped(m, inner, depth - 1);
    if (t) return t;
  }
  return null;
}

/* --------------------------------------------------------------------------
   Attribuering: varje geometriinstans bokförs på den byggdel och den
   representationsform som först gör anspråk på den. Delad geometri räknas
   alltså en gång, och summan blir aldrig större än filen.
   -------------------------------------------------------------------------- */
function attributeGeometry(m, roots, prog) {
  const n = m.n;
  const owner = new Int32Array(n).fill(-1);      // index i grupplistan
  const groups = [];                             // { cls, ident, rtype, bytes, count, products }
  const gKey = new Map();
  const attrs = [];
  const stack = [];

  const tPDS = m.typeIds.get('IFCPRODUCTDEFINITIONSHAPE');
  const tSR = m.typeIds.get('IFCSHAPEREPRESENTATION');

  /* produkterna: rotobjekt vars attribut 7 pekar på en IfcProductDefinitionShape */
  const prodOf = [];
  for (let i = 0; i < n; i++) {
    if (!roots[i]) continue;
    splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
    /* IfcProduct: GlobalId, OwnerHistory, Name, Description, ObjectType,
       ObjectPlacement, Representation — Representation är alltså attribut 6. */
    if (attrs.length < 14) continue;
    const rep = refAt(m, attrs[12], attrs[13]);
    if (rep < 0 || m.tId[rep] !== tPDS) continue;
    prodOf.push(i, rep);
  }

  const step = Math.max(1, Math.floor(prodOf.length / 40));
  for (let k = 0; k < prodOf.length; k += 2) {
    const prod = prodOf[k], pds = prodOf[k + 1];
    const cls = m.typeOf(prod);
    /* shape representations under formdefinitionen */
    splitAttrs(m.buf, m.pStart(pds), m.pEnd(pds), attrs);
    const reps = attrs.length >= 6 ? refListAt(m, attrs[4], attrs[5]) : [];
    for (const rep of reps) {
      if (m.tId[rep] !== tSR) continue;
      const ra = [];
      splitAttrs(m.buf, m.pStart(rep), m.pEnd(rep), ra);
      const ident = ra.length >= 4 ? (quotedAt(m.buf, ra[2], ra[3]) || '?') : '?';
      let rtype = ra.length >= 6 ? (quotedAt(m.buf, ra[4], ra[5]) || '?') : '?';
      /* "MappedRepresentation" säger inget om formen — den riktiga geometrin
         ligger en nivå ner via IfcMappedItem. Följ dit så att BREP räknas
         som BREP och inte försvinner i mappningen. */
      const mapped = (rtype === 'MappedRepresentation');
      if (mapped) {
        const inner = resolveMapped(m, rep, 3);
        if (inner) rtype = inner;
      }
      const key = cls + '|' + ident + '|' + rtype + (mapped ? '|m' : '');
      let gi = gKey.get(key);
      if (gi === undefined) {
        gi = groups.length;
        groups.push({ cls: cls, ident: ident, rtype: rtype, mapped: mapped,
                      bytes: 0, count: 0, products: 0 });
        gKey.set(key, gi);
      }
      groups[gi].products++;
      /* gå ner i grenen och bokför allt som ingen tagit än */
      stack.length = 0;
      stack.push(rep);
      while (stack.length) {
        const x = stack.pop();
        if (owner[x] !== -1) continue;
        owner[x] = gi;
        groups[gi].bytes += entBytes(m, x);
        groups[gi].count++;
        const a = m.refOff[x], b = m.refOff[x + 1];
        for (let q = a; q < b; q++) if (owner[m.refIdx[q]] === -1) stack.push(m.refIdx[q]);
      }
    }
    if (prog && (k % step) === 0) prog(k / Math.max(prodOf.length, 1));
  }

  groups.sort(function (a, b) { return b.bytes - a.bytes; });

  /* summering per byggdelsklass — antalet objekt räknas unikt, inte per
     representation, annars räknas samma pelare flera gånger */
  const byClass = new Map();
  for (const g of groups) {
    let c = byClass.get(g.cls);
    if (!c) { c = { cls: g.cls, bytes: 0, products: 0, forms: {} }; byClass.set(g.cls, c); }
    c.bytes += g.bytes;
    c.forms[g.rtype] = (c.forms[g.rtype] || 0) + g.bytes;
  }
  for (let k = 0; k < prodOf.length; k += 2) {
    const c = byClass.get(m.typeOf(prodOf[k]));
    if (c) c.products++;
  }
  const classes = Array.from(byClass.values()).sort(function (a, b) { return b.bytes - a.bytes; });
  for (const c of classes) {
    if (!c.products) c.products = 1;
    c.perProduct = c.bytes / c.products;
  }

  /* summering per representationsform */
  const byForm = new Map();
  for (const g of groups) {
    const k = g.rtype;
    let f = byForm.get(k);
    if (!f) { f = { rtype: k, bytes: 0, reps: 0 }; byForm.set(k, f); }
    f.bytes += g.bytes; f.reps += g.products;
  }
  const forms = Array.from(byForm.values()).sort(function (a, b) { return b.bytes - a.bytes; });

  /* summering per representationsidentifierare (Body / Axis / FootPrint / Box) */
  const byIdent = new Map();
  for (const g of groups) {
    let f = byIdent.get(g.ident);
    if (!f) { f = { ident: g.ident, bytes: 0, reps: 0 }; byIdent.set(g.ident, f); }
    f.bytes += g.bytes; f.reps += g.products;
  }
  const idents = Array.from(byIdent.values()).sort(function (a, b) { return b.bytes - a.bytes; });

  let attributed = 0;
  for (const g of groups) attributed += g.bytes;
  return { groups: groups.slice(0, 60), allGroups: groups, classes: classes, forms: forms,
           idents: idents, attributed: attributed, products: prodOf.length / 2, owner: owner };
}

/* --------------------------------------------------------------------------
   Egenskapsuppsättningar grupperade på namn, med hela sitt innehåll räknat
   -------------------------------------------------------------------------- */
function psetsByName(m, prog) {
  const out = new Map();
  const seen = new Uint8Array(m.n);
  const attrs = [];
  const stack = [];
  const tPS = m.typeIds.get('IFCPROPERTYSET');
  const tEQ = m.typeIds.get('IFCELEMENTQUANTITY');
  if (tPS === undefined && tEQ === undefined) return [];

  for (let i = 0; i < m.n; i++) {
    const t = m.tId[i];
    if (t !== tPS && t !== tEQ) continue;
    splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
    if (attrs.length < 6) continue;
    const name = quotedAt(m.buf, attrs[4], attrs[5]) || '(utan namn)';
    const kind = (t === tEQ) ? 'mängder' : 'egenskaper';
    const key = kind + '|' + name;
    let e = out.get(key);
    if (!e) { e = { name: name, kind: kind, bytes: 0, count: 0, props: 0 }; out.set(key, e); }
    e.count++;
    stack.length = 0; stack.push(i);
    while (stack.length) {
      const x = stack.pop();
      if (seen[x]) continue;
      seen[x] = 1;
      e.bytes += entBytes(m, x);
      if (x !== i) e.props++;
      const a = m.refOff[x], b = m.refOff[x + 1];
      for (let q = a; q < b; q++) {
        const c = m.refIdx[q];
        /* följ bara ner i egenskaperna, inte ut i ägarhistorik m.m. */
        if (!seen[c] && !m.typeOf(c).startsWith('IFCOWNER') && !m.typeOf(c).startsWith('IFCPERSON')) stack.push(c);
      }
    }
  }
  /* relationerna som kopplar ihop dem kostar också */
  const tRel = m.typeIds.get('IFCRELDEFINESBYPROPERTIES');
  let relBytes = 0, relCount = 0;
  if (tRel !== undefined) {
    for (let i = 0; i < m.n; i++) if (m.tId[i] === tRel) { relBytes += entBytes(m, i); relCount++; }
  }
  const list = Array.from(out.values()).sort(function (a, b) { return b.bytes - a.bytes; });
  if (relBytes) list.push({ name: 'kopplingar objekt → egenskaper', kind: 'relationer',
                            bytes: relBytes, count: relCount, props: 0 });
  return list;
}

/* --------------------------------------------------------------------------
   Uppskattning av hur mycket som är rena dubbletter (en runda, inte hela
   fixpunkten — alltså ett golv, den riktiga siffran är högre)
   -------------------------------------------------------------------------- */
function estimateDuplicates(m, roots, o, prog) {
  const n = m.n;
  const canon = new Int32Array(n);
  for (let i = 0; i < n; i++) canon[i] = i;
  const st = { override: new Map(), alive: new Uint8Array(n).fill(1) };
  const ctx = {
    m: m, st: st, roundKind: buildRoundKinds(m, !!o.roundCoords),
    coordDec: o.coordDec, ratioDec: o.ratioDec,
    mapId: function (idx) { return idx; }
  };
  const hs = new HashSink();
  const cand = [];
  for (let i = 0; i < n; i++) if (!roots[i]) cand.push(i);
  if (!cand.length) return { bytes: 0, count: 0 };

  const k = cand.length;
  const hash = new Uint32Array(k);
  for (let j = 0; j < k; j++) {
    const i = cand[j];
    hs.reset(); hs.uint(m.tId[i]);
    emitParams(ctx, i, hs);
    hash[j] = hs.h >>> 0;
    if (prog && (j & 0x3FFFF) === 0) prog(j / k);
  }
  const order = radixOrder(hash, k);
  const ss = new StrSink();
  let bytes = 0, count = 0;
  let j = 0;
  const texts = new Map();
  while (j < k) {
    let e = j + 1;
    const h = hash[order[j]];
    while (e < k && hash[order[e]] === h) e++;
    if (e - j > 1) {
      texts.clear();
      for (let x = j; x < e; x++) {
        const i = cand[order[x]];
        ss.reset(); ss.str(m.typeOf(i)); ss.byte(CH_LP);
        emitParams(ctx, i, ss);
        const key = ss.value();
        if (texts.has(key)) { bytes += entBytes(m, i); count++; }
        else texts.set(key, i);
      }
    }
    j = e;
  }
  return { bytes: bytes, count: count };
}

/* --------------------------------------------------------------------------
   Diverse räkningar som reglerna behöver
   -------------------------------------------------------------------------- */
function countTypes(m, names) {
  let bytes = 0, count = 0;
  for (const nm of names) {
    const t = m.typeIds.get(nm);
    if (t === undefined) continue;
    count += m.typeCount[t];
    bytes += m.typeBytes[t];
  }
  return { bytes: bytes, count: count };
}

function prefixStats(m, pred) {
  let bytes = 0, count = 0;
  for (let t = 1; t < m.typeNames.length; t++) {
    if (!pred(m.typeNames[t])) continue;
    count += m.typeCount[t];
    bytes += m.typeBytes[t];
  }
  return { bytes: bytes, count: count };
}

/* punktlistornas storlek per faceset — säger något om tessellationsnivån */
function tessellationStats(m) {
  const tPL = m.typeIds.get('IFCCARTESIANPOINTLIST3D');
  const tTF = m.typeIds.get('IFCTRIANGULATEDFACESET');
  const tPF = m.typeIds.get('IFCPOLYGONALFACESET');
  if (tPL === undefined) return null;
  let points = 0, lists = 0, bytes = 0;
  const attrs = [];
  for (let i = 0; i < m.n; i++) {
    if (m.tId[i] !== tPL) continue;
    lists++;
    bytes += entBytes(m, i);
    /* räkna kommatecken i yttersta listan i stället för att tolka allt */
    let depth = 0, commas = 0;
    const s = m.pStart(i), e = m.pEnd(i);
    for (let p = s; p < e; p++) {
      const c = m.buf[p];
      if (c === CH_LP) depth++;
      else if (c === CH_RP) depth--;
      else if (c === CH_COMMA && depth === 1) commas++;
    }
    points += commas + 1;
  }
  let sets = 0;
  if (tTF !== undefined) sets += m.typeCount[tTF];
  if (tPF !== undefined) sets += m.typeCount[tPF];
  void attrs;
  return { lists: lists, points: points, bytes: bytes, sets: sets,
           pointsPerSet: sets ? points / sets : 0 };
}

/* hur stor andel av byggdelarna återanvänder geometri via IfcMappedItem */
function instancingStats(m, attribution) {
  const tMI = m.typeIds.get('IFCMAPPEDITEM');
  const mapped = tMI === undefined ? 0 : m.typeCount[tMI];
  let mappedReps = 0, totalReps = 0;
  for (const g of attribution.allGroups) {
    if (String(g.ident).toUpperCase() !== 'BODY') continue;
    totalReps += g.products;
    if (g.mapped) mappedReps += g.products;
  }
  return { mappedItems: mapped, mappedReps: mappedReps, totalReps: totalReps,
           share: totalReps ? mappedReps / totalReps : 0 };
}

/* --------------------------------------------------------------------------
   diagnoseModel — allt ovan i ett svep
   -------------------------------------------------------------------------- */
function diagnoseModel(m, roots, o, hooks) {
  const prog = (hooks && hooks.prog) || function () {};
  const log = (hooks && hooks.log) || function () {};
  const d = {};

  prog('Bygger referensgraf', 0.30);
  buildRefs(m, function (f) { prog('Bygger referensgraf', 0.30 + f * 0.12); });

  prog('Bokför geometrin', 0.44);
  const attribution = attributeGeometry(m, roots, function (f) { prog('Bokför geometrin', 0.44 + f * 0.16); });
  d.classes = attribution.classes.slice(0, 40);
  d.forms = attribution.forms;
  d.idents = attribution.idents;
  d.groups = attribution.groups.slice(0, 30);
  d.products = attribution.products;
  d.attributedBytes = attribution.attributed;

  prog('Summerar egenskaper', 0.62);
  d.psets = psetsByName(m).slice(0, 40);

  d.tess = tessellationStats(m);
  d.instancing = instancingStats(m, attribution);

  d.counts = {
    spaces: countTypes(m, ['IFCSPACE']),
    spaceBoundaries: prefixStats(m, function (t) { return t.startsWith('IFCRELSPACEBOUNDARY'); }),
    openings: countTypes(m, ['IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCRELVOIDSELEMENT']),
    annotations: countTypes(m, ['IFCANNOTATION']),
    grids: countTypes(m, ['IFCGRID', 'IFCGRIDAXIS']),
    layers: countTypes(m, ['IFCPRESENTATIONLAYERASSIGNMENT']),
    materials: prefixStats(m, function (t) { return t.startsWith('IFCMATERIAL'); }),
    styles: prefixStats(m, function (t) {
      return t.indexOf('STYLE') >= 0 || t.startsWith('IFCCOLOUR');
    }),
    types: prefixStats(m, function (t) { return t.endsWith('TYPE') && !t.startsWith('IFCREL'); }),
    connects: prefixStats(m, function (t) { return t.startsWith('IFCRELCONNECTS'); }),
    boundingBox: countTypes(m, ['IFCBOUNDINGBOX'])
  };

  prog('Letar dubbletter', 0.74);
  d.duplicates = estimateDuplicates(m, roots, o, function (f) { prog('Letar dubbletter', 0.74 + f * 0.18); });
  log('Dubblettuppskattning: ' + fmtNum(d.duplicates.count) + ' instanser (' +
      fmtBytes(d.duplicates.bytes) + ') är exakta kopior av något annat.');

  prog('Klar', 1);
  return d;
}
