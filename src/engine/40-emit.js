/* ==========================================================================
   40-emit.js  ·  gemensam utskrift av attributtext
   --------------------------------------------------------------------------
   Samma kod används både när vi hashar instanser (dubblettsökning) och när
   filen skrivs ut. Det garanterar att "lika enligt hashen" betyder exakt
   "lika i utfilen".
   ========================================================================== */

class HashSink {
  constructor() { this.h = hashInit(); }
  reset() { this.h = hashInit(); return this; }
  byte(b) { this.h = hashByte(this.h, b); }
  raw(buf, from, to) { let h = this.h; for (let i = from; i < to; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193); } this.h = h; }
  str(s) { this.h = hashStr(this.h, s); }
  uint(v) { this.h = hashInt(this.h, v); }
}

class StrSink {
  constructor() { this.parts = []; }
  reset() { this.parts.length = 0; return this; }
  byte(b) { this.parts.push(String.fromCharCode(b)); }
  raw(buf, from, to) { this.parts.push(ascii(buf, from, to)); }
  str(s) { this.parts.push(s); }
  uint(v) { this.parts.push(String(v)); }
  value() { return this.parts.join(''); }
}

function isNumStart(c) { return (c >= CH_0 && c <= CH_9) || c === CH_DOT || c === CH_MINUS || c === CH_PLUS; }
function isNumChar(c) {
  return (c >= CH_0 && c <= CH_9) || c === CH_DOT || c === CH_MINUS || c === CH_PLUS || c === CH_E || c === CH_e;
}

/* hoppa förbi en citerad sträng; p pekar på inledande ' */
function skipQuotedFrom(buf, p, to) {
  p++;
  while (p < to) {
    if (buf[p] === CH_QUOTE) {
      if (p + 1 < to && buf[p + 1] === CH_QUOTE) { p += 2; continue; }
      return p + 1;
    }
    p++;
  }
  return p;
}

/* --------------------------------------------------------------------------
   Skriv attributtexten för instans i till sink.
   ctx = { m, st, mapId(idx)->nummer, roundKind:Int8Array, coordDec, ratioDec }
   -------------------------------------------------------------------------- */
function emitParams(ctx, i, sink) {
  const ov = ctx.st.override.get(i);
  const kind = ctx.roundKind[ctx.m.tId[i]];
  const dec = kind === 0 ? ctx.coordDec : (kind === 1 ? ctx.ratioDec : -1);
  if (ov === undefined) {
    emitBytes(ctx, ctx.m.buf, ctx.m.pStart(i), ctx.m.pEnd(i), dec, sink);
  } else {
    emitString(ctx, ov, dec, sink);
  }
}

function emitBytes(ctx, buf, from, to, dec, sink) {
  const m = ctx.m;
  let p = from, run = from;
  while (p < to) {
    const c = buf[p];
    if (c === CH_QUOTE) { p = skipQuotedFrom(buf, p, to); continue; }
    if (c === CH_HASH) {
      let q = p + 1, id = 0, nd = 0;
      while (q < to && isDigit(buf[q])) { id = id * 10 + (buf[q] - CH_0); q++; nd++; }
      if (nd > 0) {
        if (p > run) sink.raw(buf, run, p);
        const t = m.idxOf(id);
        sink.byte(CH_HASH);
        sink.uint(t >= 0 ? ctx.mapId(t) : id);
        p = q; run = p; continue;
      }
      p++; continue;
    }
    if (dec >= 0 && isNumStart(c)) {
      let q = p;
      while (q < to && isNumChar(buf[q])) q++;
      if (isRealToken(buf, p, q)) {
        const d = decimalsOf(buf, p, q);
        if (d < 0 || d > dec) {
          if (p > run) sink.raw(buf, run, p);
          const v = parseFloat(ascii(buf, p, q));
          sink.str(fmtReal(v, dec));
          p = q; run = p; continue;
        }
      }
      p = q; continue;
    }
    p++;
  }
  if (p > run) sink.raw(buf, run, p);
}

function emitString(ctx, s, dec, sink) {
  const m = ctx.m;
  const L = s.length;
  let p = 0, run = 0;
  const flush = function (end) { if (end > run) sink.str(s.slice(run, end)); };
  while (p < L) {
    const c = s.charCodeAt(p);
    if (c === CH_QUOTE) {
      p++;
      while (p < L) {
        if (s.charCodeAt(p) === CH_QUOTE) {
          if (p + 1 < L && s.charCodeAt(p + 1) === CH_QUOTE) { p += 2; continue; }
          p++; break;
        }
        p++;
      }
      continue;
    }
    if (c === CH_HASH) {
      let q = p + 1, id = 0, nd = 0;
      while (q < L) { const d = s.charCodeAt(q); if (d < CH_0 || d > CH_9) break; id = id * 10 + (d - CH_0); q++; nd++; }
      if (nd > 0) {
        flush(p);
        const t = m.idxOf(id);
        sink.byte(CH_HASH);
        sink.uint(t >= 0 ? ctx.mapId(t) : id);
        p = q; run = p; continue;
      }
      p++; continue;
    }
    if (dec >= 0 && isNumStart(c)) {
      let q = p;
      while (q < L && isNumChar(s.charCodeAt(q))) q++;
      const tok = s.slice(p, q);
      if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(tok) && /[.eE]/.test(tok)) {
        const dotIdx = tok.indexOf('.');
        const hasExp = /[eE]/.test(tok);
        const nd = (dotIdx < 0 || hasExp) ? -1 : tok.length - dotIdx - 1;
        if (nd < 0 || nd > dec) {
          flush(p);
          sink.str(fmtReal(parseFloat(tok), dec));
          p = q; run = p; continue;
        }
      }
      p = q; continue;
    }
    p++;
  }
  flush(p);
}

/* per typ: -1 = rör inga tal, 0 = koordinatprecision, 1 = riktningsprecision */
function buildRoundKinds(m, enabled) {
  const nt = m.typeNames.length;
  const k = new Int8Array(nt).fill(-1);
  if (!enabled) return k;
  for (let t = 1; t < nt; t++) {
    const name = m.typeNames[t];
    if (ROUND_COORD.has(name)) k[t] = 0;
    else if (ROUND_RATIO.has(name)) k[t] = 1;
  }
  return k;
}
