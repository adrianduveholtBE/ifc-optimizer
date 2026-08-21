/* ==========================================================================
   10-parse.js  ·  STEP/SPF-läsare på byte-nivå
   --------------------------------------------------------------------------
   Vi bygger aldrig strängar av hela filen. Varje instans lagras som offset
   i originalbufferten, vilket gör att 100-300 MB-modeller går att hantera.
   ========================================================================== */

const T_UNKNOWN = 0;

/* --------------------------------------------------------------------------
   IdIndex — uppslag instansnummer -> index, på typade fält.
   En JS Map tar slut vid ~16,7 miljoner poster, vilket en riktigt stor modell
   överskrider. Öppen adressering har ingen sådan gräns.
   -------------------------------------------------------------------------- */
class IdIndex {
  constructor(n) {
    let cap = 16;
    const want = Math.max(16, Math.ceil((n + 1) / 0.6));
    while (cap < want) cap *= 2;
    this.mask = cap - 1;
    this.keys = new Uint32Array(cap);      // 0 = ledig plats (IFC-id börjar på 1)
    this.vals = new Uint32Array(cap);      // index + 1
  }
  set(id, v) {
    if (id === 0) return;
    const k = this.keys, mask = this.mask;
    let i = (Math.imul(id, 2654435761) >>> 0) & mask;
    while (k[i] !== 0 && k[i] !== id) i = (i + 1) & mask;
    k[i] = id; this.vals[i] = v;
  }
  get(id) {
    const k = this.keys, mask = this.mask;
    let i = (Math.imul(id, 2654435761) >>> 0) & mask;
    while (k[i] !== 0) {
      if (k[i] === id) return this.vals[i];
      i = (i + 1) & mask;
    }
    return 0;
  }
}

class IfcModel {
  constructor(buf) {
    this.buf = buf;
    this.n = 0;
    this.ids = null;      // Uint32Array  — instansnummer (#123 -> 123)
    this.pOff = null;     // Uint32Array  — offset för '(' som öppnar attributlistan
    this.eOff = null;     // Uint32Array  — offset efter ')' som stänger den
    this.tId = null;      // Uint16Array  — typindex
    this.typeNames = [];  // typindex -> 'IFCWALL'
    this.typeIds = new Map();
    this.typeCount = null;
    this.typeBytes = null;
    this.headStart = 0;
    this.headEnd = 0;     // offset efter 'DATA;'
    this.dataEnd = 0;     // offset för 'ENDSEC;' som stänger DATA
    this.tailStart = 0;
    this._map = null;     // Uint32Array (idx+1) eller Map
    this._mapArr = false;
    this._extra = null;   // id -> idx+1 för instanser vi lagt till själva
    this.maxId = 0;
    this.schema = '';
    this.refOff = null; this.refIdx = null;
    this.parOff = null; this.parIdx = null;
  }

  typeOf(i) { return this.typeNames[this.tId[i]]; }
  idxOf(id) {
    if (this._extra !== null) {
      const x = this._extra.get(id);
      if (x !== undefined) return x - 1;
    }
    if (this._mapArr) { const v = id < this._map.length ? this._map[id] : 0; return v - 1; }
    return this._map.get(id) - 1;
  }
  /* attributlistans inre gränser (utan parenteser) */
  pStart(i) { return this.pOff[i] + 1; }
  pEnd(i) { return this.eOff[i] - 1; }
}

/* hoppa över blanktecken och /* kommentarer *\/ */
function skipWs(buf, i, end) {
  while (i < end) {
    const c = buf[i];
    if (isWs(c)) { i++; continue; }
    if (c === CH_SLASH && i + 1 < end && buf[i + 1] === CH_STAR) {
      i += 2;
      while (i + 1 < end && !(buf[i] === CH_STAR && buf[i + 1] === CH_SLASH)) i++;
      i += 2; continue;
    }
    break;
  }
  return i;
}

/* skanna balanserad parentesgrupp; i pekar på '('. Returnerar offset efter ')' */
function skipGroup(buf, i, end) {
  let depth = 0;
  while (i < end) {
    const c = buf[i];
    if (c === CH_QUOTE) {                      // sträng
      i++;
      while (i < end) {
        if (buf[i] === CH_QUOTE) {
          if (i + 1 < end && buf[i + 1] === CH_QUOTE) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (c === CH_SLASH && i + 1 < end && buf[i + 1] === CH_STAR) {
      i += 2;
      while (i + 1 < end && !(buf[i] === CH_STAR && buf[i + 1] === CH_SLASH)) i++;
      i += 2; continue;
    }
    if (c === CH_LP) { depth++; i++; continue; }
    if (c === CH_RP) { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  return -1;
}

function findSeq(buf, needle, from, to) {
  const n0 = needle[0], L = needle.length;
  const last = (to === undefined ? buf.length : to) - L;
  for (let i = from; i <= last; i++) {
    if (buf[i] !== n0) continue;
    let k = 1;
    while (k < L && buf[i + k] === needle[k]) k++;
    if (k === L) return i;
  }
  return -1;
}
function findSeqBack(buf, needle, from) {
  const n0 = needle[0], L = needle.length;
  for (let i = from; i >= 0; i--) {
    if (buf[i] !== n0) continue;
    let k = 1;
    while (k < L && buf[i + k] === needle[k]) k++;
    if (k === L) return i;
  }
  return -1;
}

const SEQ_DATA = asciiBytes('DATA;');
const SEQ_ENDSEC = asciiBytes('ENDSEC;');
const SEQ_END_ISO = asciiBytes('END-ISO-10303-21');
const SEQ_SCHEMA = asciiBytes('FILE_SCHEMA');

/* --------------------------------------------------------------------------
   parseIndex — bygger instansindexet
   -------------------------------------------------------------------------- */
function parseIndex(buf, progress) {
  const m = new IfcModel(buf);
  const N = buf.length;

  const dataKw = findSeq(buf, SEQ_DATA, 0, Math.min(N, 1 << 20));
  if (dataKw < 0) throw new Error('Filen saknar DATA-sektion — är det verkligen en IFC-fil (SPF)?');
  m.headEnd = dataKw + SEQ_DATA.length;

  const endIso = findSeqBack(buf, SEQ_END_ISO, N - SEQ_END_ISO.length);
  const searchTo = endIso > 0 ? endIso : N - 1;
  const endsec = findSeqBack(buf, SEQ_ENDSEC, searchTo - SEQ_ENDSEC.length);
  m.dataEnd = endsec > m.headEnd ? endsec : N;
  m.tailStart = m.dataEnd;

  // schema ur headern
  const sc = findSeq(buf, SEQ_SCHEMA, 0, m.headEnd);
  if (sc > 0) {
    const q1 = findSeq(buf, asciiBytes("'"), sc, m.headEnd);
    if (q1 > 0) {
      let q2 = q1 + 1;
      while (q2 < m.headEnd && buf[q2] !== CH_QUOTE) q2++;
      m.schema = ascii(buf, q1 + 1, q2).toUpperCase();
    }
  }

  // Pass 1: räkna instanser
  let count = 0, maxId = 0;
  {
    let i = m.headEnd;
    const end = m.dataEnd;
    while (i < end) {
      i = skipWs(buf, i, end);
      if (i >= end) break;
      if (buf[i] !== CH_HASH) { i++; continue; }
      let j = i + 1, id = 0, nd = 0;
      while (j < end && isDigit(buf[j])) { id = id * 10 + (buf[j] - CH_0); j++; nd++; }
      if (nd === 0) { i++; continue; }
      j = skipWs(buf, j, end);
      if (j >= end || buf[j] !== CH_EQ) { i = j; continue; }
      j = skipWs(buf, j + 1, end);
      // typnamn (kan saknas vid komplexa instanser: #1=(A(..),B(..));)
      while (j < end && isNameChar(buf[j])) j++;
      j = skipWs(buf, j, end);
      if (j >= end || buf[j] !== CH_LP) { i = j; continue; }
      const after = skipGroup(buf, j, end);
      if (after < 0) break;
      count++; if (id > maxId) maxId = id;
      let k = skipWs(buf, after, end);
      if (k < end && buf[k] === CH_SEMI) k++;
      i = k;
    }
  }
  if (count === 0) throw new Error('Hittade inga IFC-instanser i DATA-sektionen.');

  m.n = count;
  m.maxId = maxId;
  m.ids = new Uint32Array(count);
  m.pOff = new Uint32Array(count);
  m.eOff = new Uint32Array(count);
  m.tId = new Uint16Array(count);

  /* Tät numrering (normalfallet) -> direktindexerat fält, 4 byte per id.
     Gles eller extremt hög numrering -> hashtabell dimensionerad efter
     antalet instanser i stället för högsta id. */
  if (maxId <= 20000000 || (maxId <= count * 4 + 1000000 && maxId <= 260000000)) {
    m._map = new Uint32Array(maxId + 1); m._mapArr = true;
  } else {
    m._map = new IdIndex(count); m._mapArr = false;
  }

  m.typeNames.push('*UNKNOWN*'); m.typeIds.set('*UNKNOWN*', 0);

  // Pass 2: fyll indexet. Typstatistiken summeras här, så att vi slipper
  // spara statementets startoffset för varje instans.
  const tCount = [], tBytes = [];
  {
    let i = m.headEnd, w = 0;
    const end = m.dataEnd;
    const nextProg = Math.max(1, Math.floor(count / 20));
    while (i < end && w < count) {
      i = skipWs(buf, i, end);
      if (i >= end) break;
      if (buf[i] !== CH_HASH) { i++; continue; }
      const s = i;
      let j = i + 1, id = 0, nd = 0;
      while (j < end && isDigit(buf[j])) { id = id * 10 + (buf[j] - CH_0); j++; nd++; }
      if (nd === 0) { i++; continue; }
      j = skipWs(buf, j, end);
      if (j >= end || buf[j] !== CH_EQ) { i = j; continue; }
      j = skipWs(buf, j + 1, end);
      const tS = j;
      while (j < end && isNameChar(buf[j])) j++;
      const tE = j;
      j = skipWs(buf, j, end);
      if (j >= end || buf[j] !== CH_LP) { i = j; continue; }
      const after = skipGroup(buf, j, end);
      if (after < 0) break;

      let tid = 0;
      if (tE > tS) {
        const name = ascii(buf, tS, tE).toUpperCase();
        let t = m.typeIds.get(name);
        if (t === undefined) {
          t = m.typeNames.length;
          if (t > 65530) t = 0;
          else { m.typeNames.push(name); m.typeIds.set(name, t); }
        }
        tid = t;
      }
      m.ids[w] = id; m.pOff[w] = j; m.eOff[w] = after; m.tId[w] = tid;
      if (m._mapArr) m._map[id] = w + 1; else m._map.set(id, w + 1);
      tCount[tid] = (tCount[tid] || 0) + 1;
      tBytes[tid] = (tBytes[tid] || 0) + (after - s) + 2;   // +2 ~ ';' + radbrytning
      w++;
      if (progress && (w % nextProg) === 0) progress(w / count);

      let k = skipWs(buf, after, end);
      if (k < end && buf[k] === CH_SEMI) k++;
      i = k;
    }
    m.n = w;
  }

  const nt = m.typeNames.length;
  m.typeCount = new Uint32Array(nt);
  m.typeBytes = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    m.typeCount[t] = tCount[t] || 0;
    m.typeBytes[t] = tBytes[t] || 0;
  }
  return m;
}

/* --------------------------------------------------------------------------
   buildRefs — referensgraf (barn) + omvänd graf (föräldrar), CSR-format
   -------------------------------------------------------------------------- */
function buildRefs(m, progress) {
  const buf = m.buf, n = m.n;
  const off = new Uint32Array(n + 1);
  const vec = new I32Vec(Math.max(1024, n * 2));
  const step = Math.max(1, Math.floor(n / 20));
  m.inputDangling = 0;

  for (let i = 0; i < n; i++) {
    off[i] = vec.n;
    let p = m.pOff[i];
    const end = m.eOff[i];
    while (p < end) {
      const c = buf[p];
      if (c === CH_QUOTE) {
        p++;
        while (p < end) {
          if (buf[p] === CH_QUOTE) {
            if (p + 1 < end && buf[p + 1] === CH_QUOTE) { p += 2; continue; }
            p++; break;
          }
          p++;
        }
        continue;
      }
      if (c === CH_SLASH && p + 1 < end && buf[p + 1] === CH_STAR) {
        p += 2;
        while (p + 1 < end && !(buf[p] === CH_STAR && buf[p + 1] === CH_SLASH)) p++;
        p += 2; continue;
      }
      if (c === CH_HASH) {
        let q = p + 1, id = 0, nd = 0;
        while (q < end && isDigit(buf[q])) { id = id * 10 + (buf[q] - CH_0); q++; nd++; }
        if (nd > 0) {
          const t = m.idxOf(id);
          if (t >= 0) vec.push(t); else m.inputDangling++;
          p = q; continue;
        }
      }
      p++;
    }
    if (progress && (i % step) === 0) progress(i / n);
  }
  off[n] = vec.n;
  m.refOff = off;
  m.refIdx = vec.trim();

  // omvänd graf
  const pc = new Uint32Array(n + 1);
  const R = m.refIdx, total = R.length;
  for (let k = 0; k < total; k++) pc[R[k] + 1]++;
  for (let i = 0; i < n; i++) pc[i + 1] += pc[i];
  const pIdx = new Int32Array(total);
  const cursor = pc.slice(0, n);
  for (let i = 0; i < n; i++) {
    const a = off[i], b = off[i + 1];
    for (let k = a; k < b; k++) { const c = R[k]; pIdx[cursor[c]++] = i; }
  }
  m.parOff = pc;
  m.parIdx = pIdx;
  return m;
}

/* --------------------------------------------------------------------------
   attributhjälpare
   -------------------------------------------------------------------------- */
/* Dela attributlistan på kommatecken i toppnivå. Returnerar [s0,e0,s1,e1,...] */
function splitAttrs(buf, from, to, out) {
  out.length = 0;
  let depth = 0, s = from, i = from;
  while (i < to) {
    const c = buf[i];
    if (c === CH_QUOTE) {
      i++;
      while (i < to) {
        if (buf[i] === CH_QUOTE) {
          if (i + 1 < to && buf[i + 1] === CH_QUOTE) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (c === CH_SLASH && i + 1 < to && buf[i + 1] === CH_STAR) {
      i += 2;
      while (i + 1 < to && !(buf[i] === CH_STAR && buf[i + 1] === CH_SLASH)) i++;
      i += 2; continue;
    }
    if (c === CH_LP) { depth++; i++; continue; }
    if (c === CH_RP) { depth--; i++; continue; }
    if (c === CH_COMMA && depth === 0) { out.push(s, i); s = i + 1; i++; continue; }
    i++;
  }
  out.push(s, to);
  return out;
}

/* attributens gränser för instans i (cachas inte — anropa sparsamt) */
function attrsOf(m, i, out) {
  return splitAttrs(m.buf, m.pStart(i), m.pEnd(i), out || []);
}

/* trimma blanktecken i [s,e) */
function trimRange(buf, s, e) {
  while (s < e && isWs(buf[s])) s++;
  while (e > s && isWs(buf[e - 1])) e--;
  return [s, e];
}

/* citerad sträng i [s,e) -> JS-sträng, eller null */
function quotedAt(buf, s, e) {
  const t = trimRange(buf, s, e); s = t[0]; e = t[1];
  if (s >= e || buf[s] !== CH_QUOTE || buf[e - 1] !== CH_QUOTE) return null;
  let out = '';
  for (let i = s + 1; i < e - 1; i++) {
    if (buf[i] === CH_QUOTE && i + 1 < e - 1 && buf[i + 1] === CH_QUOTE) { out += "'"; i++; continue; }
    out += String.fromCharCode(buf[i]);
  }
  return out;
}

/* längden på citerad sträng utan att bygga JS-strängen (för GlobalId-test) */
function quotedLen(buf, s, e) {
  const t = trimRange(buf, s, e); s = t[0]; e = t[1];
  if (s >= e || buf[s] !== CH_QUOTE || buf[e - 1] !== CH_QUOTE) return -1;
  let len = 0;
  for (let i = s + 1; i < e - 1; i++) {
    if (buf[i] === CH_QUOTE && i + 1 < e - 1 && buf[i + 1] === CH_QUOTE) { i++; }
    len++;
  }
  return len;
}

/* enkel referens i [s,e) -> instansindex, annars -1 */
function refAt(m, s, e) {
  const buf = m.buf;
  const t = trimRange(buf, s, e); s = t[0]; e = t[1];
  if (s >= e || buf[s] !== CH_HASH) return -1;
  let id = 0, nd = 0, i = s + 1;
  while (i < e && isDigit(buf[i])) { id = id * 10 + (buf[i] - CH_0); i++; nd++; }
  if (nd === 0 || i !== e) return -1;
  return m.idxOf(id);
}

/* alla referenser i en lista "(#1,#2,...)" -> array av instansindex */
function refListAt(m, s, e) {
  const buf = m.buf;
  const t = trimRange(buf, s, e); s = t[0]; e = t[1];
  const out = [];
  if (s >= e || buf[s] !== CH_LP) return out;
  const inner = [];
  splitAttrs(buf, s + 1, e - 1, inner);
  for (let k = 0; k < inner.length; k += 2) {
    const r = refAt(m, inner[k], inner[k + 1]);
    if (r >= 0) out.push(r);
  }
  return out;
}

/* råtext för ett attribut (trimmat) */
function attrText(m, s, e) {
  const t = trimRange(m.buf, s, e);
  return ascii(m.buf, t[0], t[1]);
}
