/* ==========================================================================
   80-api.js  ·  körschema och förinställningar
   ========================================================================== */

/* Inställningarna definieras i 05-options.js (delas med gränssnittet). */
/* ------------------------------------------------------------------------- */
async function analyseFile(bytes, opts, hooks) {
  const h = hooks || {};
  const log = h.log || function () {};
  const prog = h.prog || function () {};
  let u8 = bytes;
  let zipped = false;
  if (looksZipped(u8)) {
    const r = await unzipFirstIfc(u8);
    u8 = r.bytes; zipped = true;
    log('Packade upp ' + r.name + ' (' + fmtBytes(u8.length) + ').');
  }
  prog('Läser', 0.02);
  const m = parseIndex(u8, function (f) { prog('Läser instanser', 0.05 + f * 0.5); });
  prog('Analyserar', 0.6);
  const roots = detectRoots(m, function (f) { prog('Analyserar', 0.6 + f * 0.15); });
  const o = opts || baseOptions();
  const unit = detectLengthUnit(m);
  o.coordDec = decimalsFor(unit.factor, (o.tolMm || 0.01) / 1000);
  const rep = analyseModel(m, roots, o);
  rep.zipped = zipped;
  rep.rawBytes = u8.length;
  rep.coordDec = o.coordDec;
  prog('Klar', 1);
  return { report: rep, model: m, roots: roots, bytes: u8 };
}

function looksZipped(u8) {
  return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7);
}

/* rekonstruera referensgrafen efter att geometrin ändrats */
function rebuildGraph(m, st) {
  const n = m.n;
  const off = new Uint32Array(n + 1);
  const vec = new I32Vec(Math.max(1024, n * 2));
  const kids = [];
  for (let i = 0; i < n; i++) {
    off[i] = vec.n;
    st.children(i, kids);
    for (let k = 0; k < kids.length; k++) vec.push(kids[k]);
  }
  off[n] = vec.n;
  const R = vec.trim();
  const pc = new Uint32Array(n + 1);
  for (let k = 0; k < R.length; k++) pc[R[k] + 1]++;
  for (let i = 0; i < n; i++) pc[i + 1] += pc[i];
  const pIdx = new Int32Array(R.length);
  const cursor = pc.slice(0, n);
  for (let i = 0; i < n; i++) for (let k = off[i]; k < off[i + 1]; k++) pIdx[cursor[R[k]]++] = i;
  m.refOff = off; m.refIdx = R; m.parOff = pc; m.parIdx = pIdx;
}

async function optimizeFile(bytes, opts, hooks, pre) {
  const h = hooks || {};
  const log = h.log || function () {};
  const prog = h.prog || function () {};
  const t0 = nowMs();
  const timing = {};
  const mark = function (name, from) { timing[name] = Math.round(nowMs() - from); };

  let m, roots, u8, analysis;
  if (pre) { m = pre.model; roots = pre.roots; u8 = pre.bytes; analysis = pre.report; }
  else {
    const a = await analyseFile(bytes, opts, { log: log, prog: function (s, f) { prog(s, f * 0.25); } });
    m = a.model; roots = a.roots; u8 = a.bytes; analysis = a.report;
  }
  const o = opts;
  const sizeBefore = u8.length;

  let tp = nowMs();
  prog('Bygger referensgraf', 0.28);
  buildRefs(m, function (f) { prog('Bygger referensgraf', 0.28 + f * 0.12); });
  mark('graf', tp);

  const st = new StripState(m, roots);

  tp = nowMs();
  prog('Rensar', 0.42);
  markDeaths(m, st, o, log);
  repairRefs(m, st, log, function (f) { prog('Lagar referenser', 0.44 + f * 0.06); });
  mark('rensning', tp);

  let geom = null, weldRes = null, boxRes = null;
  if (o.boxify || o.weld || o.mergeCoplanar) {
    tp = nowMs();
    if (o.boxify) { prog('Ersätter geometri med lådor', 0.52); boxRes = boxifyGeometry(m, st, o, log, null); }
    if (o.weld) {
      prog('Svetsar hörn', 0.55);
      o.weldDec = decimalsFor(analysis.unit.factor, (o.weldTolMm || 0.5) / 1000);
      weldRes = weldPointLists(m, st, o, log, null);
    }
    if (o.mergeCoplanar) {
      prog('Slår ihop koplanära ytor', 0.58);
      geom = mergeCoplanarFaces(m, st, o, log, function (f) { prog('Slår ihop koplanära ytor', 0.58 + f * 0.1); });
    }
    rebuildGraph(m, st);
    repairRefs(m, st, log, null);
    mark('geometri', tp);
  }

  tp = nowMs();
  if (o.gc) { prog('Skräpsamlar', 0.7); collectGarbage(m, st, log, function (f) { prog('Skräpsamlar', 0.7 + f * 0.05); }); }
  mark('skräp', tp);

  tp = nowMs();
  prog('Söker dubbletter', 0.76);
  const dd = dedupRecursive(m, st, o, log, function (f) { prog('Söker dubbletter', 0.76 + f * 0.1); });
  mark('dubbletter', tp);

  tp = nowMs();
  prog('Skriver fil', 0.88);
  const w = writeModel(m, st, dd.canon, o, log, function (f) { prog('Skriver fil', 0.88 + f * 0.07); });
  mark('skrivning', tp);

  let verify = null;
  if (o.verify && w.bytes < 300 * 1048576) {
    tp = nowMs();
    prog('Kontrollerar resultatet', 0.96);
    try {
      verify = verifyOutput(w.blocks, w.count, m.inputDangling || 0);
    } catch (e) {
      verify = { ok: false, problems: ['kontrollen kunde inte läsa filen: ' + (e && e.message)], instances: 0 };
    }
    mark('kontroll', tp);
    if (verify.ok) {
      log('Integritetskontroll: OK (' + fmtNum(verify.instances) + ' instanser, inga nya brutna referenser).');
      if (verify.inherited) {
        log('Obs: ' + fmtNum(verify.inherited) + ' brutna referenser fanns redan i originalfilen och följer med.');
      }
    } else log('VARNING: ' + verify.problems.join('; '));
  }
  if (m.inputDangling) {
    log('Originalfilen innehåller ' + fmtNum(m.inputDangling) + ' referenser till objekt som inte finns.');
  }
  if (w.dangling > 0) log('VARNING: ' + w.dangling + ' referenser kunde inte skrivas korrekt.');

  let blocks = w.blocks;
  let ext = '.ifc';
  if (o.zip) {
    prog('Komprimerar', 0.98);
    tp = nowMs();
    const inner = String((o.name || 'model.ifc')).replace(/\.(ifczip|ifc)$/i, '') + '.ifc';
    blocks = await zipSingle(inner, w.blocks);
    ext = '.ifczip';
    mark('zip', tp);
  }
  let outBytes = 0;
  for (const b of blocks) outBytes += b.length;

  /* topplista över vad som togs bort */
  const removed = [];
  for (const kv of st.killedType) removed.push({ name: kv[0], count: kv[1] });
  removed.sort(function (a, b) { return b.count - a.count; });

  prog('Klar', 1);
  return {
    blocks: blocks, ext: ext,
    report: {
      analysis: analysis,
      sizeBefore: sizeBefore,
      sizeAfter: outBytes,
      rawAfter: w.bytes,
      instancesBefore: analysis.instances,
      instancesAfter: w.count,
      merged: dd.merged,
      dedupRounds: dd.rounds,
      resurrected: st.resurrected,
      removed: removed.slice(0, 25),
      removedTotal: analysis.instances - w.count,
      geom: geom, weld: weldRes, box: boxRes,
      verify: verify,
      dangling: w.dangling,
      inputDangling: m.inputDangling || 0,
      zip: !!o.zip,
      timing: timing,
      totalMs: Math.round(nowMs() - t0)
    }
  };
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
