/* ==========================================================================
   IFC Optimizer — BIM Engine
   00-util.js  ·  byte-nivå hjälpfunktioner, talformatering, CRC32, ZIP
   ========================================================================== */
'use strict';

/* --- teckenkoder vi använder ofta ---------------------------------------- */
const CH_HASH = 35, CH_EQ = 61, CH_LP = 40, CH_RP = 41, CH_SEMI = 59,
      CH_QUOTE = 39, CH_COMMA = 44, CH_STAR = 42, CH_SLASH = 47,
      CH_DOT = 46, CH_MINUS = 45, CH_PLUS = 43, CH_E = 69, CH_e = 101,
      CH_0 = 48, CH_9 = 57, CH_A = 65, CH_Z = 90, CH_a = 97, CH_z = 122,
      CH_US = 95, CH_SP = 32, CH_TAB = 9, CH_CR = 13, CH_LF = 10, CH_DOLLAR = 36;

function isDigit(c) { return c >= CH_0 && c <= CH_9; }
function isWs(c) { return c === CH_SP || c === CH_LF || c === CH_CR || c === CH_TAB; }
function isNameChar(c) {
  return (c >= CH_A && c <= CH_Z) || (c >= CH_a && c <= CH_z) || isDigit(c) || c === CH_US || c === CH_MINUS;
}

/* Läs ASCII-sträng ur en byte-buffer. IFC-filer är ASCII med \X2\-escapes,
   så byte -> char 1:1 är förlustfritt. */
function ascii(buf, from, to) {
  let s = '';
  const CHUNK = 8192;
  for (let i = from; i < to; i += CHUNK) {
    const end = Math.min(i + CHUNK, to);
    s += String.fromCharCode.apply(null, buf.subarray(i, end));
  }
  return s;
}

function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/* --- växande Int32-vektor (referenslistor) ------------------------------- */
class I32Vec {
  constructor(cap) { this.a = new Int32Array(cap || 1024); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a); this.a = b;
    }
    this.a[this.n++] = v;
  }
  trim() { return this.a.subarray(0, this.n); }
}

/* --- utskriftsbuffert i block (undviker en enda gigantisk allokering) ---- */
class ByteSink {
  constructor(blockSize) {
    this.bs = blockSize || (4 << 20);
    this.blocks = [];
    this.cur = new Uint8Array(this.bs);
    this.p = 0;
    this.done = 0;          // bytes i redan stängda block
  }
  _flush(need) {
    this.blocks.push(this.cur.subarray(0, this.p));
    this.done += this.p;
    this.cur = new Uint8Array(Math.max(this.bs, need));
    this.p = 0;
  }
  byte(b) {
    if (this.p === this.cur.length) this._flush(1);
    this.cur[this.p++] = b;
  }
  raw(buf, from, to) {
    let i = from;
    while (i < to) {
      if (this.p === this.cur.length) this._flush(1);
      const n = Math.min(to - i, this.cur.length - this.p);
      this.cur.set(buf.subarray(i, i + n), this.p);
      this.p += n; i += n;
    }
  }
  str(s) {
    if (this.p + s.length > this.cur.length) this._flush(s.length);
    const c = this.cur; let p = this.p;
    for (let i = 0; i < s.length; i++) c[p++] = s.charCodeAt(i) & 0xff;
    this.p = p;
  }
  /* positivt heltal, utan strängallokering */
  uint(v) {
    if (v === 0) { this.byte(CH_0); return; }
    const tmp = ByteSink._tmp;
    let n = 0;
    while (v > 0) { const q = Math.floor(v / 10); tmp[n++] = CH_0 + (v - q * 10); v = q; }
    if (this.p + n > this.cur.length) this._flush(n);
    const c = this.cur; let p = this.p;
    while (n > 0) c[p++] = tmp[--n];
    this.p = p;
  }
  size() { return this.done + this.p; }
  finish() {
    if (this.p > 0) { this.blocks.push(this.cur.subarray(0, this.p)); this.done += this.p; this.p = 0; }
    this.cur = new Uint8Array(0);
    return this.blocks;
  }
}
ByteSink._tmp = new Uint8Array(24);

/* --- talformatering ------------------------------------------------------
   STEP kräver punkt i REAL: "5." är giltigt, "5" är ett heltal.            */
function fmtReal(v, dec) {
  if (!isFinite(v)) return '0.';
  let s = v.toFixed(dec);
  const dot = s.indexOf('.');
  if (dot >= 0) {
    let end = s.length;
    while (end > dot + 1 && s.charCodeAt(end - 1) === CH_0) end--;
    s = s.slice(0, end);
  } else {
    s += '.';
  }
  if (s === '-0.') s = '0.';
  return s;
}

/* Är [from,to) ett REAL-token (dvs innehåller punkt eller exponent)?       */
function isRealToken(buf, from, to) {
  let hasDot = false, hasDigit = false, hasExp = false;
  for (let i = from; i < to; i++) {
    const c = buf[i];
    if (isDigit(c)) hasDigit = true;
    else if (c === CH_DOT) hasDot = true;
    else if (c === CH_E || c === CH_e) hasExp = true;
    else if (c === CH_MINUS || c === CH_PLUS) { /* tecken */ }
    else return false;
  }
  return hasDigit && (hasDot || hasExp);
}

/* Antal decimaler i ett REAL-token. -1 = exponentform. */
function decimalsOf(buf, from, to) {
  let dot = -1;
  for (let i = from; i < to; i++) {
    const c = buf[i];
    if (c === CH_DOT) dot = i;
    else if (c === CH_E || c === CH_e) return -1;
  }
  if (dot < 0) return 0;
  return to - dot - 1;
}

/* --- 32-bitars hash (FNV-1a över bytes) ---------------------------------- */
function hashInit() { return 0x811c9dc5 | 0; }
function hashByte(h, b) { h ^= b; return Math.imul(h, 0x01000193); }
function hashStr(h, s) { for (let i = 0; i < s.length; i++) h = hashByte(h, s.charCodeAt(i) & 0xff); return h; }
function hashInt(h, v) {
  h = hashByte(h, v & 0xff); h = hashByte(h, (v >>> 8) & 0xff);
  h = hashByte(h, (v >>> 16) & 0xff); h = hashByte(h, (v >>> 24) & 0xff);
  return h;
}

/* --- CRC32 (ZIP) --------------------------------------------------------- */
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32Blocks(blocks) {
  let c = -1;
  for (const b of blocks) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* --- ZIP: skriv enfilsarkiv (.ifczip) ------------------------------------ */
async function zipSingle(nameStr, blocks) {
  const nameB = asciiBytes(nameStr);
  let raw = 0; for (const b of blocks) raw += b.length;
  const crc = crc32Blocks(blocks);

  let comp = null;
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const pump = (async () => {
      for (const b of blocks) await writer.write(b);
      await writer.close();
    })();
    comp = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    await pump;
  }
  const method = comp ? 8 : 0;
  const payloadLen = comp ? comp.length : raw;

  const head = new DataView(new ArrayBuffer(30));
  head.setUint32(0, 0x04034b50, true);
  head.setUint16(4, 20, true);
  head.setUint16(6, 0x0800, true);
  head.setUint16(8, method, true);
  head.setUint16(10, 0, true);
  head.setUint16(12, 0x21, true);
  head.setUint32(14, crc, true);
  head.setUint32(18, payloadLen, true);
  head.setUint32(22, raw, true);
  head.setUint16(26, nameB.length, true);
  head.setUint16(28, 0, true);

  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
  cd.setUint16(8, 0x0800, true);
  cd.setUint16(10, method, true);
  cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true);
  cd.setUint32(16, crc, true);
  cd.setUint32(20, payloadLen, true);
  cd.setUint32(24, raw, true);
  cd.setUint16(28, nameB.length, true);
  cd.setUint32(38, 0, true);
  cd.setUint32(42, 0, true);

  const cdSize = 46 + nameB.length;
  const cdOff = 30 + nameB.length + payloadLen;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true); eocd.setUint16(10, 1, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdOff, true);

  const parts = [new Uint8Array(head.buffer), nameB];
  if (comp) parts.push(comp); else for (const b of blocks) parts.push(b);
  parts.push(new Uint8Array(cd.buffer), nameB, new Uint8Array(eocd.buffer));
  return parts;
}

/* --- ZIP: packa en Blob (CRC och obehandlad storlek redan kända) ---------
   Används av snabbläget, där utdatat aldrig ligger samlat i minnet.        */
async function zipFromBlob(nameStr, blob, crc, rawSize) {
  const nameB = asciiBytes(nameStr);
  let payload = blob, method = 0;
  if (typeof CompressionStream !== 'undefined' && blob.stream) {
    const cs = new CompressionStream('deflate-raw');
    payload = await new Response(blob.stream().pipeThrough(cs)).blob();
    method = 8;
  }
  const head = new DataView(new ArrayBuffer(30));
  head.setUint32(0, 0x04034b50, true);
  head.setUint16(4, 20, true);
  head.setUint16(6, 0x0800, true);
  head.setUint16(8, method, true);
  head.setUint16(12, 0x21, true);
  head.setUint32(14, crc, true);
  head.setUint32(18, payload.size, true);
  head.setUint32(22, rawSize, true);
  head.setUint16(26, nameB.length, true);

  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
  cd.setUint16(8, 0x0800, true);
  cd.setUint16(10, method, true);
  cd.setUint16(14, 0x21, true);
  cd.setUint32(16, crc, true);
  cd.setUint32(20, payload.size, true);
  cd.setUint32(24, rawSize, true);
  cd.setUint16(28, nameB.length, true);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true); eocd.setUint16(10, 1, true);
  eocd.setUint32(12, 46 + nameB.length, true);
  eocd.setUint32(16, 30 + nameB.length + payload.size, true);

  return new Blob([new Uint8Array(head.buffer), nameB, payload,
                   new Uint8Array(cd.buffer), nameB, new Uint8Array(eocd.buffer)]);
}

/* --- ZIP: läs första IFC-posten ur ett arkiv ----------------------------- */
async function unzipFirstIfc(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Ogiltigt ZIP-arkiv (hittar ingen katalog).');
  const nEntries = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < nEntries; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const cSize = dv.getUint32(p + 20, true);
    const uSize = dv.getUint32(p + 24, true);
    const nLen = dv.getUint16(p + 28, true);
    const eLen = dv.getUint16(p + 30, true);
    const cLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = ascii(u8, p + 46, p + 46 + nLen);
    const lower = name.toLowerCase();
    if (lower.endsWith('.ifc') || lower.endsWith('.stp') || lower.endsWith('.step')) {
      const lhNameLen = dv.getUint16(lho + 26, true);
      const lhExtra = dv.getUint16(lho + 28, true);
      const dataOff = lho + 30 + lhNameLen + lhExtra;
      const payload = u8.subarray(dataOff, dataOff + cSize);
      if (method === 0) return { name, bytes: payload };
      if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('Webbläsaren kan inte packa upp ZIP.');
        const ds = new DecompressionStream('deflate-raw');
        const w = ds.writable.getWriter();
        w.write(payload); w.close();
        const out = new Uint8Array(await new Response(ds.readable).arrayBuffer());
        if (uSize && out.length !== uSize) throw new Error('ZIP-uppackningen gav fel storlek.');
        return { name, bytes: out };
      }
      throw new Error('ZIP-posten använder komprimering vi inte stöder (metod ' + method + ').');
    }
    p += 46 + nLen + eLen + cLen;
  }
  throw new Error('Hittade ingen IFC-fil inne i arkivet.');
}

/* --- småformat ----------------------------------------------------------- */
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1).replace('.', ',') + ' kB';
  if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
}
function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function fmtPct(x) { return (x * 100).toFixed(1).replace('.', ',') + ' %'; }
