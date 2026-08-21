/* ==========================================================================
   75-analyse.js  ·  storleksrapport: var ligger byten?
   ========================================================================== */

function headerField(m, kw, attrIndex) {
  const buf = m.buf;
  const at = findSeq(buf, asciiBytes(kw), 0, m.headEnd);
  if (at < 0) return null;
  let p = at + kw.length;
  while (p < m.headEnd && buf[p] !== CH_LP) p++;
  const close = skipGroup(buf, p, m.headEnd);
  if (close < 0) return null;
  const attrs = [];
  splitAttrs(buf, p + 1, close - 1, attrs);
  if (attrs.length < (attrIndex + 1) * 2) return null;
  const s = attrs[attrIndex * 2], e = attrs[attrIndex * 2 + 1];
  const q = quotedAt(buf, s, e);
  if (q !== null) return q;
  return attrText(m, s, e);
}

function detectLengthUnit(m) {
  const attrs = [];
  for (let i = 0; i < m.n; i++) {
    const t = m.typeOf(i);
    if (t !== 'IFCSIUNIT') continue;
    splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
    if (attrs.length < 8) continue;
    const utype = attrText(m, attrs[2], attrs[3]);
    if (utype !== '.LENGTHUNIT.') continue;
    const prefix = attrText(m, attrs[4], attrs[5]);
    const name = attrText(m, attrs[6], attrs[7]);
    let factor = 1, label = 'm';
    if (prefix === '.MILLI.') { factor = 0.001; label = 'mm'; }
    else if (prefix === '.CENTI.') { factor = 0.01; label = 'cm'; }
    else if (prefix === '.DECI.') { factor = 0.1; label = 'dm'; }
    else if (prefix === '.KILO.') { factor = 1000; label = 'km'; }
    if (name === '.METRE.' || name === '.METER.') return { label: label, factor: factor };
    return { label: label, factor: factor };
  }
  for (let i = 0; i < m.n; i++) {
    if (m.typeOf(i) !== 'IFCCONVERSIONBASEDUNIT') continue;
    splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
    if (attrs.length < 6) continue;
    const nm = quotedAt(m.buf, attrs[4], attrs[5]);
    if (nm) {
      const low = nm.toLowerCase();
      if (low.indexOf('foot') >= 0 || low.indexOf('feet') >= 0) return { label: 'ft', factor: 0.3048 };
      if (low.indexOf('inch') >= 0) return { label: 'in', factor: 0.0254 };
    }
  }
  return { label: 'm', factor: 1 };
}

/* hur många byte kan avrundningen spara? (sampling för stora modeller) */
function estimateRounding(m, coordDec, ratioDec) {
  const nt = m.typeNames.length;
  const kind = new Int8Array(nt).fill(-1);
  for (let t = 1; t < nt; t++) {
    if (ROUND_COORD.has(m.typeNames[t])) kind[t] = 0;
    else if (ROUND_RATIO.has(m.typeNames[t])) kind[t] = 1;
  }
  const cand = [];
  for (let i = 0; i < m.n; i++) if (kind[m.tId[i]] >= 0) cand.push(i);
  if (!cand.length) return { saving: 0, values: 0, longValues: 0, sampled: 0, maxDecimals: 0 };

  const MAX = 120000;
  const stride = cand.length > MAX ? Math.ceil(cand.length / MAX) : 1;
  let sampled = 0, saving = 0, values = 0, longValues = 0, maxDec = 0;
  const buf = m.buf;
  for (let k = 0; k < cand.length; k += stride) {
    const i = cand[k];
    sampled++;
    const dec = kind[m.tId[i]] === 0 ? coordDec : ratioDec;
    let p = m.pStart(i);
    const end = m.pEnd(i);
    while (p < end) {
      const c = buf[p];
      if (c === CH_QUOTE) { p = skipQuotedFrom(buf, p, end); continue; }
      if (isNumStart(c)) {
        let q = p;
        while (q < end && isNumChar(buf[q])) q++;
        if (isRealToken(buf, p, q)) {
          values++;
          const d = decimalsOf(buf, p, q);
          if (d > maxDec) maxDec = d;
          if (d < 0 || d > dec) {
            longValues++;
            const v = parseFloat(ascii(buf, p, q));
            const nl = fmtReal(v, dec).length;
            if (q - p > nl) saving += (q - p) - nl;
          }
        }
        p = q; continue;
      }
      p++;
    }
  }
  return {
    saving: Math.round(saving * stride), values: values * stride,
    longValues: longValues * stride, sampled: sampled, maxDecimals: maxDec
  };
}

function analyseModel(m, roots, o) {
  const nt = m.typeNames.length;
  const catBytes = new Float64Array(CAT_LABEL.length);
  const catCount = new Uint32Array(CAT_LABEL.length);
  const typeCat = new Uint8Array(nt);
  for (let t = 1; t < nt; t++) typeCat[t] = categoryOf(m.typeNames[t]);
  for (let t = 1; t < nt; t++) {
    catBytes[typeCat[t]] += m.typeBytes[t];
    catCount[typeCat[t]] += m.typeCount[t];
  }

  const types = [];
  for (let t = 1; t < nt; t++) {
    if (!m.typeCount[t]) continue;
    types.push({ name: m.typeNames[t], count: m.typeCount[t], bytes: m.typeBytes[t], cat: typeCat[t] });
  }
  types.sort(function (a, b) { return b.bytes - a.bytes; });

  const elements = types.filter(function (x) { return isElementClass(x.name); })
                        .sort(function (a, b) { return b.bytes - a.bytes; });

  const cats = [];
  for (let c = 0; c < CAT_LABEL.length; c++) {
    if (!catCount[c]) continue;
    cats.push({ cat: c, label: CAT_LABEL[c], bytes: catBytes[c], count: catCount[c] });
  }
  cats.sort(function (a, b) { return b.bytes - a.bytes; });

  let rootCount = 0;
  for (let i = 0; i < m.n; i++) if (roots[i]) rootCount++;

  const unit = detectLengthUnit(m);
  const round = estimateRounding(m, o.coordDec, o.ratioDec);

  const byName = {};
  for (const t of types) byName[t.name] = t;
  const bytesOf = function (names) {
    let s = 0;
    for (const nm of names) if (byName[nm]) s += byName[nm].bytes;
    return s;
  };
  const catOf = function (c) { return catBytes[c]; };

  return {
    bytes: m.buf.length,
    instances: m.n,
    types: types.length,
    roots: rootCount,
    schema: m.schema,
    unit: unit,
    tool: headerField(m, 'FILE_NAME', 5) || '',
    author: '',
    view: headerField(m, 'FILE_DESCRIPTION', 0) || '',
    dataBytes: m.dataEnd - m.headEnd,
    cats: cats,
    topTypes: types.slice(0, 30),
    elements: elements.slice(0, 40),
    round: round,
    est: {
      psets: catOf(CAT.PROP),
      quantities: catOf(CAT.QTY),
      typeObjects: catOf(CAT.TYPE) + bytesOf(['IFCRELDEFINESBYTYPE']),
      materials: catOf(CAT.MAT) + bytesOf(['IFCRELASSOCIATESMATERIAL']),
      styles: catOf(CAT.STYLE),
      drawing: catOf(CAT.DRAW),
      spaces: catOf(CAT.SPACE),
      openings: catOf(CAT.OPEN),
      rounding: round.saving,
      brep: catOf(CAT.BREP),
      tess: catOf(CAT.TESS),
      points: catOf(CAT.PT)
    }
  };
}
