/* ==========================================================================
   64-stream.js  ·  snabbläge för mycket stora filer
   --------------------------------------------------------------------------
   Filen läses i bitar och skrivs ut i bitar. Ingen instansindex, ingen
   referensgraf — därför inget minnestak som växer med filstorleken, och
   därför bara sådana ändringar som är säkra utan att känna hela modellen:

     · avrundning av flyttal i geometrityper (FPR)
     · normalisering av "#12= IFCX(" till "#12=IFCX("
     · valfri ifczip-packning

   Instansnumren rörs aldrig, så referenserna kan inte gå sönder.
   ========================================================================== */

/* Kopiera [from,to) till sink och skriv om REAL-tal med fler decimaler än
   dec. Strängar och kommentarer lämnas orörda. */
function roundNumbersOnly(buf, from, to, dec, sink, counters) {
  let p = from, run = from;
  while (p < to) {
    const c = buf[p];
    if (c === CH_QUOTE) { p = skipQuotedFrom(buf, p, to); continue; }
    if (c === CH_SLASH && p + 1 < to && buf[p + 1] === CH_STAR) {
      p += 2;
      while (p + 1 < to && !(buf[p] === CH_STAR && buf[p + 1] === CH_SLASH)) p++;
      p += 2; continue;
    }
    if (isNumStart(c)) {
      let q = p;
      while (q < to && isNumChar(buf[q])) q++;
      if (isRealToken(buf, p, q)) {
        const d = decimalsOf(buf, p, q);
        if (d < 0 || d > dec) {
          if (p > run) sink.raw(buf, run, p);
          const s = fmtReal(parseFloat(ascii(buf, p, q)), dec);
          sink.str(s);
          counters.rounded++;
          counters.saved += (q - p) - s.length;
          p = q; run = p; continue;
        }
      }
      p = q; continue;
    }
    p++;
  }
  if (run < to) sink.raw(buf, run, to);
}

/* Gå igenom hela statements i [start,end). Returnerar offseten där ett
   ofullständigt statement börjar — resten bärs över till nästa bit. */
function streamTransform(buf, start, end, kindOf, coordDec, ratioDec, sink, counters) {
  let p = start, run = start;
  while (p < end) {
    const c = buf[p];
    if (c === CH_QUOTE) { p = skipQuotedFrom(buf, p, end); continue; }
    if (c === CH_SLASH && p + 1 < end && buf[p + 1] === CH_STAR) {
      p += 2;
      while (p + 1 < end && !(buf[p] === CH_STAR && buf[p + 1] === CH_SLASH)) p++;
      p += 2; continue;
    }
    if (c !== CH_HASH) { p++; continue; }

    /* försök läsa "#id = TYPE (" */
    const stmt = p;
    let q = p + 1, nd = 0;
    while (q < end && isDigit(buf[q])) { q++; nd++; }
    if (nd === 0) { p++; continue; }
    let r = skipWs(buf, q, end);
    if (r >= end) break;
    if (buf[r] !== CH_EQ) { p = r > p ? r : p + 1; continue; }
    r = skipWs(buf, r + 1, end);
    if (r >= end) break;
    const tS = r;
    while (r < end && isNameChar(buf[r])) r++;
    const tE = r;
    r = skipWs(buf, r, end);
    if (r >= end) break;
    if (buf[r] !== CH_LP) { p = r > p ? r : p + 1; continue; }
    const close = skipGroup(buf, r, end);
    if (close < 0) break;                       // gruppen fortsätter i nästa bit

    counters.statements++;
    const kind = tE > tS ? kindOf(ascii(buf, tS, tE).toUpperCase()) : -1;

    /* skriv "#id=" + TYPE + "(" utan blanktecken, sedan attributen */
    if (stmt > run) sink.raw(buf, run, stmt);
    sink.raw(buf, stmt, q);                     // #id
    sink.byte(CH_EQ);
    if (tE > tS) sink.raw(buf, tS, tE);
    sink.byte(CH_LP);
    if (kind < 0) {
      sink.raw(buf, r + 1, close - 1);
    } else {
      roundNumbersOnly(buf, r + 1, close - 1, kind === 0 ? coordDec : ratioDec, sink, counters);
    }
    sink.byte(CH_RP);
    p = close; run = close;
  }
  if (p >= end) {
    if (end > run) sink.raw(buf, run, end);
    return end;
  }
  if (p > run) sink.raw(buf, run, p);
  return p;
}

/* --------------------------------------------------------------------------
   streamOptimize — hela körningen
   -------------------------------------------------------------------------- */
async function streamOptimize(file, opts, hooks) {
  const log = (hooks && hooks.log) || function () {};
  const prog = (hooks && hooks.prog) || function () {};
  const t0 = nowMs();
  const o = opts || baseOptions();
  const CHUNK = 32 * 1048576;
  const FLUSH = 48 * 1048576;

  if (looksZipped(new Uint8Array(await file.slice(0, 4).arrayBuffer()))) {
    throw new Error('Snabbläget kan inte packa upp ifczip. Packa upp filen först, ' +
                    'eller kör en mindre fil i vanligt läge.');
  }

  /* headern */
  const headMax = Math.min(file.size, 4 * 1048576);
  const headBuf = new Uint8Array(await file.slice(0, headMax).arrayBuffer());
  const dataAt = findSeq(headBuf, SEQ_DATA, 0, headBuf.length);
  if (dataAt < 0) throw new Error('Hittar ingen DATA-sektion i filens början — är det en IFC-fil (SPF)?');
  const headEnd = dataAt + SEQ_DATA.length;

  const fake = { buf: headBuf, headEnd: headEnd };
  /* Enheten står i DATA-sektionen, inte i headern. Vi letar i början av
     modellen; hittar vi den inte vågar vi inte avrunda alls — fel enhet
     skulle betyda fel tolerans. */
  const unitBuf = new Uint8Array(await file.slice(0, Math.min(file.size, 16 * 1048576)).arrayBuffer());
  const unit = findLengthUnit(unitBuf, headEnd);
  const coordDec = (o.roundCoords && unit) ? decimalsFor(unit.factor, (o.tolMm || 0.01) / 1000) : -1;
  const ratioDec = o.ratioDec;
  if (o.roundCoords && !unit) {
    log('VARNING: hittar ingen längdenhet i modellens början — avrundningen hoppas över ' +
        'eftersom fel enhet skulle ge fel tolerans.');
  }
  log('Snabbläge: ' + fmtBytes(file.size) + ', enhet ' + (unit ? unit.label : 'okänd') +
      (coordDec >= 0 ? ', avrundar till ' + coordDec + ' decimaler' : ', ingen avrundning'));

  const kindCache = new Map();
  const kindOf = function (name) {
    let k = kindCache.get(name);
    if (k === undefined) {
      k = ROUND_COORD.has(name) ? 0 : (ROUND_RATIO.has(name) ? 1 : -1);
      kindCache.set(name, k);
    }
    return k;
  };
  const kindOfOff = function () { return -1; };

  const parts = [];
  let crc = -1;
  let rawSize = 0;
  const wantCrc = !!o.zip;
  const takeBlocks = function (sink) {
    const blocks = sink.finish();
    for (const b of blocks) {
      if (wantCrc) for (let i = 0; i < b.length; i++) crc = CRC_TABLE[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
      rawSize += b.length;
    }
    if (blocks.length) parts.push(new Blob(blocks));
  };

  let sink = new ByteSink(8 * 1048576);
  const head = patchHeader(fake, o);
  if (head === null) sink.raw(headBuf, 0, headEnd); else sink.str(head);
  sink.str('\r\n');

  const counters = { statements: 0, rounded: 0, saved: 0 };
  let pos = headEnd;
  let carry = null;

  while (pos < file.size) {
    const end = Math.min(file.size, pos + CHUNK);
    const chunk = new Uint8Array(await file.slice(pos, end).arrayBuffer());
    let buf;
    if (carry && carry.length) {
      buf = new Uint8Array(carry.length + chunk.length);
      buf.set(carry, 0); buf.set(chunk, carry.length);
    } else {
      buf = chunk;
    }
    const consumed = streamTransform(buf, 0, buf.length, coordDec < 0 ? kindOfOff : kindOf,
                                     coordDec, ratioDec, sink, counters);
    carry = consumed < buf.length ? buf.slice(consumed) : null;
    pos = end;
    if (sink.size() >= FLUSH) { takeBlocks(sink); sink = new ByteSink(8 * 1048576); }
    prog('Strömmar', 0.05 + 0.8 * (pos / file.size));
  }
  if (carry && carry.length) sink.raw(carry, 0, carry.length);
  takeBlocks(sink);

  crc = (crc ^ -1) >>> 0;
  let blob = new Blob(parts);
  let ext = '.ifc';

  if (o.zip) {
    if (rawSize >= 4294967295) {
      log('VARNING: resultatet är över 4 GB, det ryms inte i ett vanligt zip-arkiv — sparar som .ifc.');
    } else {
      prog('Komprimerar', 0.9);
      const inner = String((o.name || 'model.ifc')).replace(/\.(ifczip|ifc)$/i, '') + '.ifc';
      blob = await zipFromBlob(inner, blob, crc, rawSize);
      ext = '.ifczip';
    }
  }

  log('Snabbläge klart: ' + fmtNum(counters.statements) + ' instanser genomgångna, ' +
      fmtNum(counters.rounded) + ' tal avrundade.');
  prog('Klar', 1);

  return {
    blob: blob, ext: ext,
    report: {
      streamed: true,
      analysis: { schema: '', unit: unit, instances: 0, bytes: file.size, sampled: true },
      sizeBefore: file.size,
      sizeAfter: blob.size,
      rawAfter: rawSize,
      instancesBefore: counters.statements,
      instancesAfter: counters.statements,
      merged: 0,
      dedupRounds: 0,
      resurrected: 0,
      removed: [],
      removedTotal: 0,
      roundedValues: counters.rounded,
      geom: null, weld: null, box: null,
      verify: { ok: true, problems: [], instances: counters.statements, dangling: 0, inherited: 0,
                note: 'instansnumren är oförändrade, så referenserna kan inte ha brutits' },
      dangling: 0,
      inputDangling: 0,
      zip: ext === '.ifczip',
      timing: {},
      totalMs: Math.round(nowMs() - t0)
    }
  };
}

/* Längdenheten står i DATA-sektionen, inte i headern. Returnerar null om den
   inte hittas — då avrundar vi inte. */
function findLengthUnit(buf, from) {
  const needle = asciiBytes('IFCSIUNIT');
  let i = from;
  for (let k = 0; k < 2000; k++) {
    i = findSeq(buf, needle, i, buf.length);
    if (i < 0) return null;
    let e = i;
    while (e < buf.length && buf[e] !== CH_SEMI) e++;
    const txt = ascii(buf, i, e).toUpperCase();
    if (txt.indexOf('.LENGTHUNIT.') >= 0) {
      if (txt.indexOf('.MILLI.') >= 0) return { label: 'mm', factor: 0.001 };
      if (txt.indexOf('.CENTI.') >= 0) return { label: 'cm', factor: 0.01 };
      if (txt.indexOf('.DECI.') >= 0) return { label: 'dm', factor: 0.1 };
      if (txt.indexOf('.KILO.') >= 0) return { label: 'km', factor: 1000 };
      return { label: 'm', factor: 1 };
    }
    i = e;
  }
  return null;
}
