/* ==========================================================================
   70-write.js  ·  numrera om och skriv ut filen
   --------------------------------------------------------------------------
   Referenser skrivs alltid via canon + newId, så en trasig referens är
   omöjlig att skriva utan att räknaren dangling ökar. Den räknaren är
   integritetskontrollen.
   ========================================================================== */

const STAMP = ' + BIM Engine IFC Optimizer 1.0';

function patchHeader(m, o) {
  /* returnerar antingen null (skriv originalbytes) eller en sträng */
  if (!o.stamp) return null;
  const buf = m.buf;
  const kw = findSeq(buf, asciiBytes('FILE_NAME'), 0, m.headEnd);
  if (kw < 0) return null;
  let p = kw + 9;
  while (p < m.headEnd && buf[p] !== CH_LP) p++;
  if (p >= m.headEnd) return null;
  const close = skipGroup(buf, p, m.headEnd);
  if (close < 0) return null;
  const attrs = [];
  splitAttrs(buf, p + 1, close - 1, attrs);
  if (attrs.length < 10) return null;
  const parts = [];
  for (let k = 0; k < attrs.length; k += 2) parts.push(ascii(buf, attrs[k], attrs[k + 1]));
  const cur = parts[4].trim();
  if (cur.indexOf('BIM Engine IFC Optimizer') >= 0) return null;
  if (cur.length >= 2 && cur.charCodeAt(0) === CH_QUOTE) {
    parts[4] = cur.slice(0, cur.length - 1) + STAMP.replace(/'/g, "''") + "'";
  } else {
    parts[4] = "'BIM Engine IFC Optimizer 1.0'";
  }
  return ascii(buf, 0, p + 1) + parts.join(',') + ascii(buf, close - 1, m.headEnd);
}

function writeModel(m, st, canon, o, log, prog) {
  const n = m.n;
  const newId = new Uint32Array(n);
  let count = 0;
  if (o.renumber) {
    for (let i = 0; i < n; i++) if (st.alive[i]) newId[i] = ++count;
  } else {
    for (let i = 0; i < n; i++) if (st.alive[i]) { newId[i] = m.ids[i]; count++; }
  }

  let dangling = 0;
  const ctx = {
    m: m, st: st,
    roundKind: buildRoundKinds(m, o.roundCoords),
    coordDec: o.coordDec, ratioDec: o.ratioDec,
    mapId: function (idx) {
      const r = canonFind(canon, idx);
      const v = newId[r];
      if (v === 0) { dangling++; return newId[idx] || 1; }
      return v;
    }
  };

  /* typnamn som bytes, en gång per typ */
  const tb = new Array(m.typeNames.length);
  for (let t = 0; t < m.typeNames.length; t++) tb[t] = asciiBytes(m.typeNames[t]);

  const sink = new ByteSink(8 << 20);
  const head = patchHeader(m, o);
  if (head === null) sink.raw(m.buf, 0, m.headEnd);
  else sink.str(head);
  sink.byte(CH_CR); sink.byte(CH_LF);

  const step = Math.max(1, Math.floor(n / 50));
  for (let i = 0; i < n; i++) {
    if (!st.alive[i]) continue;
    sink.byte(CH_HASH);
    sink.uint(newId[i]);
    sink.byte(CH_EQ);
    const t = m.tId[i];
    sink.raw(tb[t], 0, tb[t].length);
    sink.byte(CH_LP);
    emitParams(ctx, i, sink);
    sink.byte(CH_RP);
    sink.byte(CH_SEMI);
    sink.byte(CH_CR); sink.byte(CH_LF);
    if (prog && (i % step) === 0) prog(i / n);
  }
  sink.str('ENDSEC;\r\nEND-ISO-10303-21;\r\n');
  const blocks = sink.finish();
  return { blocks: blocks, count: count, dangling: dangling, bytes: blocks.reduce(function (s, b) { return s + b.length; }, 0) };
}

/* --------------------------------------------------------------------------
   Oberoende kontroll: läs om det vi just skrev och verifiera att varje
   referens pekar på en instans som finns.
   -------------------------------------------------------------------------- */
function verifyOutput(blocks, expectCount, allowedDangling) {
  let total = 0;
  for (const b of blocks) total += b.length;
  const buf = new Uint8Array(total);
  let p = 0;
  for (const b of blocks) { buf.set(b, p); p += b.length; }
  const m2 = parseIndex(buf, null);
  const problems = [];
  if (m2.n !== expectCount) problems.push('antal instanser ' + m2.n + ' != ' + expectCount);
  let dangling = 0;
  for (let i = 0; i < m2.n; i++) {
    let q = m2.pOff[i];
    const end = m2.eOff[i];
    while (q < end) {
      const c = buf[q];
      if (c === CH_QUOTE) { q = skipQuotedFrom(buf, q, end); continue; }
      if (c === CH_HASH) {
        let r = q + 1, id = 0, nd = 0;
        while (r < end && isDigit(buf[r])) { id = id * 10 + (buf[r] - CH_0); r++; nd++; }
        if (nd > 0) { if (m2.idxOf(id) < 0) dangling++; q = r; continue; }
      }
      q++;
    }
  }
  const inherited = Math.min(dangling, allowedDangling || 0);
  const created = dangling - inherited;
  if (created > 0) problems.push(created + ' referenser pekar på objekt som inte finns');
  return {
    ok: problems.length === 0, problems: problems, instances: m2.n, schema: m2.schema,
    dangling: dangling, inherited: inherited
  };
}
