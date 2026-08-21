/* ==========================================================================
   50-dedup.js  ·  rekursiv sammanslagning av identiska instanser
   --------------------------------------------------------------------------
   Samma idé som IfcToolbox' RE-strategi: börja underifrån, slå ihop allt som
   är identiskt, gå sedan uppåt till de instanser vars barn ändrades och
   upprepa till fixpunkt. Rotobjekt (med GlobalId) slås aldrig ihop.
   ========================================================================== */

/* find med vägkompression */
function canonFind(canon, i) {
  let r = i;
  while (canon[r] !== r) r = canon[r];
  while (canon[i] !== r) { const nx = canon[i]; canon[i] = r; i = nx; }
  return r;
}

function radixOrder(hash, k) {
  let src = new Uint32Array(k), dst = new Uint32Array(k);
  for (let i = 0; i < k; i++) src[i] = i;
  const cnt = new Uint32Array(257);
  for (let shift = 0; shift < 32; shift += 8) {
    cnt.fill(0);
    for (let i = 0; i < k; i++) cnt[(((hash[src[i]] >>> shift) & 0xff) + 1)]++;
    for (let b = 0; b < 256; b++) cnt[b + 1] += cnt[b];
    for (let i = 0; i < k; i++) dst[cnt[(hash[src[i]] >>> shift) & 0xff]++] = src[i];
    const t = src; src = dst; dst = t;
  }
  return src;
}

function unifyOwnerHistory(m, st, canon, log) {
  let first = -1, merged = 0;
  for (let i = 0; i < m.n; i++) {
    if (!st.alive[i] || m.typeOf(i) !== 'IFCOWNERHISTORY') continue;
    if (first < 0) { first = i; continue; }
    canon[i] = first; st.alive[i] = 0; merged++;
  }
  if (merged && log) log('Slog ihop ' + fmtNum(merged + 1) + ' ägarhistoriker till en.');
  return merged;
}

function dedupRecursive(m, st, o, log, prog) {
  const roots = st.roots;
  const n = m.n;
  const canon = new Int32Array(n);
  for (let i = 0; i < n; i++) canon[i] = i;

  let merged = 0;
  if (o.unifyOwnerHistory) merged += unifyOwnerHistory(m, st, canon, log);
  if (!o.dedup) return { canon: canon, merged: merged, rounds: 0 };

  const roundKind = buildRoundKinds(m, o.roundCoords);
  const ctx = {
    m: m, st: st, roundKind: roundKind,
    coordDec: o.coordDec, ratioDec: o.ratioDec,
    mapId: function (idx) { return canonFind(canon, idx); }
  };
  const hs = new HashSink();
  const ss = new StrSink();

  const eligible = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!st.alive[i] || roots[i]) continue;
    eligible[i] = 1; k++;
  }
  if (k === 0) return { canon: canon, merged: merged, rounds: 0 };

  let cand = new Uint32Array(k);
  { let w = 0; for (let i = 0; i < n; i++) if (eligible[i]) cand[w++] = i; }

  let round = 0;
  const texts = new Map();
  while (cand.length > 0 && round < 24) {
    round++;
    const kc = cand.length;
    const hash = new Uint32Array(kc);
    for (let j = 0; j < kc; j++) {
      const i = cand[j];
      hs.reset();
      hs.uint(m.tId[i]);
      emitParams(ctx, i, hs);
      hash[j] = hs.h >>> 0;
      if (prog && (j & 0x3FFFF) === 0) prog(Math.min(0.9, j / kc));
    }
    const order = radixOrder(hash, kc);

    let roundMerged = 0;
    const touched = [];
    let j = 0;
    while (j < kc) {
      let e = j + 1;
      const h = hash[order[j]];
      while (e < kc && hash[order[e]] === h) e++;
      if (e - j > 1) {
        texts.clear();
        for (let x = j; x < e; x++) {
          const i = cand[order[x]];
          if (!st.alive[i]) continue;
          ss.reset();
          ss.str(m.typeOf(i));
          ss.byte(CH_LP);
          emitParams(ctx, i, ss);
          const key = ss.value();
          const rep = texts.get(key);
          if (rep === undefined) { texts.set(key, i); continue; }
          /* i är en dubblett av rep */
          canon[i] = rep;
          st.alive[i] = 0;
          roundMerged++;
          touched.push(i);
        }
      }
      j = e;
    }
    merged += roundMerged;
    if (log) log('Dubblettrunda ' + round + ': ' + fmtNum(roundMerged) + ' instanser sammanslagna.');
    if (roundMerged === 0) break;

    /* nästa runda: föräldrarna till det som slogs ihop */
    const nextSet = new Set();
    for (const i of touched) {
      if (i >= n) continue;
      const a = m.parOff[i], b = m.parOff[i + 1];
      for (let x = a; x < b; x++) {
        const p = m.parIdx[x];
        if (eligible[p] && st.alive[p]) nextSet.add(p);
      }
    }
    cand = new Uint32Array(nextSet.size);
    { let w = 0; for (const v of nextSet) cand[w++] = v; }
  }
  return { canon: canon, merged: merged, rounds: round };
}
