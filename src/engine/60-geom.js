/* ==========================================================================
   60-geom.js  ·  geometrioptimering
   --------------------------------------------------------------------------
   1. Koplanär sammanslagning av BREP-ytor (förlustfri): trianglar som ligger
      i samma plan smälts till en enda yta med hål där det behövs. Varje skal
      valideras — summan av triangelareorna måste stämma med den nya ytans
      area, annars lämnas skalet orört.
   2. Svetsning av tessellerade punktlistor (IFC4).
   3. Ersättning av mesh med omslutande låda (aggressivt läge).
   ========================================================================== */

/* --- utöka modellen med nya instanser ------------------------------------ */
function ensureCapacity(m, st, extra) {
  const need = m.n + extra;
  if (m.ids.length >= need) return;
  const cap = Math.max(need, m.ids.length + (m.ids.length >> 1) + 64);
  const g32 = function (a) { const b = new Uint32Array(cap); b.set(a); return b; };
  m.ids = g32(m.ids); m.sOff = g32(m.sOff); m.pOff = g32(m.pOff); m.eOff = g32(m.eOff);
  const t16 = new Uint16Array(cap); t16.set(m.tId); m.tId = t16;
  const a8 = new Uint8Array(cap); a8.set(st.alive); st.alive = a8;
  const r8 = new Uint8Array(cap); r8.set(st.roots); st.roots = r8;
}

function internType(m, name) {
  let t = m.typeIds.get(name);
  if (t === undefined) { t = m.typeNames.length; m.typeNames.push(name); m.typeIds.set(name, t); }
  return t;
}

function addInstance(m, st, typeName, paramsStr) {
  ensureCapacity(m, st, 1);
  const i = m.n++;
  const id = ++m.maxId;
  m.ids[i] = id; m.sOff[i] = 0; m.pOff[i] = 0; m.eOff[i] = 0;
  m.tId[i] = internType(m, typeName);
  st.alive[i] = 1; st.roots[i] = 0;
  st.override.set(i, paramsStr);
  if (!m._extra) m._extra = new Map();
  m._extra.set(id, i + 1);
  return i;
}

/* --- koordinatcache ------------------------------------------------------- */
function buildPointCache(m, st, o, prog) {
  const n = m.n;
  const slot = new Int32Array(n).fill(-1);
  let cnt = 0;
  const ptType = m.typeIds.get('IFCCARTESIANPOINT');
  if (ptType === undefined) return { slot: slot, X: new Float64Array(0), Y: new Float64Array(0), Z: new Float64Array(0), owner: new Int32Array(0), count: 0 };
  for (let i = 0; i < n; i++) if (st.alive[i] && m.tId[i] === ptType) cnt++;
  const X = new Float64Array(cnt), Y = new Float64Array(cnt), Z = new Float64Array(cnt);
  const owner = new Int32Array(cnt);
  const scale = o.roundCoords ? Math.pow(10, o.coordDec) : 0;
  const attrs = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (!st.alive[i] || m.tId[i] !== ptType) continue;
    const s = m.pStart(i), e = m.pEnd(i);
    /* attributlistan är ((x,y,z)) — plocka den inre listan */
    let p = s; while (p < e && m.buf[p] !== CH_LP) p++;
    const inner = [];
    if (p < e) {
      const close = skipGroup(m.buf, p, e + 1);
      if (close > 0) splitAttrs(m.buf, p + 1, close - 1, inner);
    }
    let x = 0, y = 0, z = 0;
    if (inner.length >= 2) x = parseFloat(attrText(m, inner[0], inner[1])) || 0;
    if (inner.length >= 4) y = parseFloat(attrText(m, inner[2], inner[3])) || 0;
    if (inner.length >= 6) z = parseFloat(attrText(m, inner[4], inner[5])) || 0;
    if (scale) { x = Math.round(x * scale) / scale; y = Math.round(y * scale) / scale; z = Math.round(z * scale) / scale; }
    X[w] = x; Y[w] = y; Z[w] = z; owner[w] = i;
    slot[i] = w; w++;
    if (prog && (w & 0x1FFFF) === 0) prog(w / Math.max(cnt, 1));
  }
  return { slot: slot, X: X, Y: Y, Z: Z, owner: owner, count: w };
}

/* --- koplanär sammanslagning --------------------------------------------- */
const EDGE_SHIFT = 67108864;   // 2^26

function mergeCoplanarFaces(m, st, o, log, prog) {
  const res = { shells: 0, shellsMerged: 0, shellsSkipped: 0, facesBefore: 0, facesAfter: 0, added: 0, removedEntities: 0 };
  const tShellClosed = m.typeIds.get('IFCCLOSEDSHELL');
  const tShellOpen = m.typeIds.get('IFCOPENSHELL');
  const tFace = m.typeIds.get('IFCFACE');
  const tLoop = m.typeIds.get('IFCPOLYLOOP');
  if (tFace === undefined || tLoop === undefined) return res;
  if (tShellClosed === undefined && tShellOpen === undefined) return res;

  const pc = buildPointCache(m, st, o, null);
  if (pc.count === 0) return res;

  const shells = [];
  for (let i = 0; i < m.n; i++) {
    if (!st.alive[i]) continue;
    const t = m.tId[i];
    if (t === tShellClosed || t === tShellOpen) shells.push(i);
  }
  res.shells = shells.length;
  if (!shells.length) return res;

  const attrs = [];
  const unit = o.coordDec > 0 ? Math.pow(10, -o.coordDec) : 1e-6;
  const areaTol = Math.max(1e-9, unit * unit * 4);

  for (let s = 0; s < shells.length; s++) {
    const sh = shells[s];
    splitAttrs(m.buf, m.pStart(sh), m.pEnd(sh), attrs);
    const faces = refListAt(m, attrs[0], attrs[1]);
    if (faces.length < 4) continue;

    /* --- läs in alla ytor --- */
    const fv = [];            // [{verts:[slot..], nx,ny,nz,d, area}]
    let bad = false;
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      if (!st.alive[f] || m.tId[f] !== tFace) { bad = true; break; }
      const fa = [];
      splitAttrs(m.buf, m.pStart(f), m.pEnd(f), fa);
      const bounds = refListAt(m, fa[0], fa[1]);
      if (bounds.length !== 1) { bad = true; break; }
      const b = bounds[0];
      if (!st.alive[b]) { bad = true; break; }
      const ba = [];
      splitAttrs(m.buf, m.pStart(b), m.pEnd(b), ba);
      const loop = refAt(m, ba[0], ba[1]);
      if (loop < 0 || m.tId[loop] !== tLoop) { bad = true; break; }
      let orient = true;
      if (ba.length >= 4) {
        const ot = attrText(m, ba[2], ba[3]);
        if (ot === '.F.') orient = false;
      }
      const la = [];
      splitAttrs(m.buf, m.pStart(loop), m.pEnd(loop), la);
      const pts = refListAt(m, la[0], la[1]);
      if (pts.length < 3) { bad = true; break; }
      const verts = new Array(pts.length);
      for (let k = 0; k < pts.length; k++) {
        const sl = pc.slot[pts[k]];
        if (sl < 0) { bad = true; break; }
        verts[k] = sl;
      }
      if (bad) break;
      if (!orient) verts.reverse();
      const pl = planeOf(pc, verts);
      if (!pl) { bad = true; break; }
      fv.push({ verts: verts, nx: pl[0], ny: pl[1], nz: pl[2], d: pl[3], area: pl[4], face: f });
    }
    if (bad || fv.length < 4) { res.shellsSkipped++; continue; }
    res.facesBefore += fv.length;

    /* --- gruppera per plan --- */
    const groups = new Map();
    for (const f of fv) {
      const key = qz(f.nx) + '|' + qz(f.ny) + '|' + qz(f.nz);
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(f);
    }

    const keptFaces = [];       // befintliga ytindex som behålls
    const newFaceRefs = [];     // {pendingIndex}
    let mergedAny = false;

    for (const g of groups.values()) {
      if (g.length < 2) { for (const f of g) keptFaces.push(f.face); continue; }
      /* klustra på planavstånd d */
      g.sort(function (a, b) { return a.d - b.d; });
      let start = 0;
      const dTol = Math.max(unit * 2, 1e-7 * (Math.abs(g[0].d) + 1));
      for (let i = 1; i <= g.length; i++) {
        if (i < g.length && Math.abs(g[i].d - g[i - 1].d) <= dTol) continue;
        const cluster = g.slice(start, i);
        start = i;
        if (cluster.length < 2) { keptFaces.push(cluster[0].face); continue; }
        const out = mergePlaneCluster(pc, cluster, areaTol);
        if (!out) { for (const f of cluster) keptFaces.push(f.face); continue; }
        /* vinstkontroll: nya instanser mot gamla */
        let newEnt = 0;
        for (const fc of out) newEnt += 1 + 2 * (1 + fc.holes.length);
        const oldEnt = cluster.length * 3;
        if (newEnt >= oldEnt) { for (const f of cluster) keptFaces.push(f.face); continue; }
        for (const fc of out) {
          const boundIds = [];
          boundIds.push(emitLoopBound(m, st, pc, fc.outer, 'IFCFACEOUTERBOUND'));
          for (const h of fc.holes) boundIds.push(emitLoopBound(m, st, pc, h, 'IFCFACEBOUND'));
          newFaceRefs.push({ bounds: boundIds });
        }
        mergedAny = true;
        res.removedEntities += oldEnt;
      }
    }

    if (!mergedAny) { res.shellsSkipped++; res.facesAfter += fv.length; continue; }

    /* skapa de nya ytorna och skriv om skalet */
    const faceIds = [];
    for (const f of keptFaces) faceIds.push('#' + m.ids[f]);
    for (const nf of newFaceRefs) {
      const fi = addInstance(m, st, 'IFCFACE', '(' + nf.bounds.join(',') + ')');
      faceIds.push('#' + m.ids[fi]);
      res.added++;
    }
    st.override.set(sh, '(' + faceIds.join(',') + ')');
    res.shellsMerged++;
    res.facesAfter += faceIds.length;
    if (prog) prog(s / shells.length);
  }
  if (log && res.shellsMerged) {
    log('Koplanära ytor: ' + fmtNum(res.facesBefore) + ' -> ' + fmtNum(res.facesAfter) +
        ' ytor i ' + fmtNum(res.shellsMerged) + ' skal.');
  }
  if (log && res.shellsSkipped) log('Lämnade ' + fmtNum(res.shellsSkipped) + ' skal orörda (kunde inte valideras).');
  return res;
}

function qz(v) { return Math.round(v * 10000) / 10000; }

/* plan ur en orienterad loop: [nx,ny,nz,d,area] */
function planeOf(pc, verts) {
  const X = pc.X, Y = pc.Y, Z = pc.Z;
  let nx = 0, ny = 0, nz = 0;
  const L = verts.length;
  for (let i = 0; i < L; i++) {
    const a = verts[i], b = verts[(i + 1) % L];
    nx += (Y[a] - Y[b]) * (Z[a] + Z[b]);
    ny += (Z[a] - Z[b]) * (X[a] + X[b]);
    nz += (X[a] - X[b]) * (Y[a] + Y[b]);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 0)) return null;
  const area = len / 2;
  nx /= len; ny /= len; nz /= len;
  const a0 = verts[0];
  const d = nx * X[a0] + ny * Y[a0] + nz * Z[a0];
  return [nx, ny, nz, d, area];
}

/* slå ihop ett kluster av koplanära ytor. Returnerar [{outer:[v..],holes:[[v..]]}] eller null */
function mergePlaneCluster(pc, cluster, areaTol) {
  const edges = new Map();
  let areaSum = 0;
  for (const f of cluster) {
    areaSum += f.area;
    const v = f.verts, L = v.length;
    for (let i = 0; i < L; i++) {
      const a = v[i], b = v[(i + 1) % L];
      if (a === b) return null;
      const kf = a * EDGE_SHIFT + b;
      const kr = b * EDGE_SHIFT + a;
      const cr = edges.get(kr);
      if (cr) {
        if (cr === 1) edges.delete(kr); else edges.set(kr, cr - 1);
        continue;
      }
      const cf = edges.get(kf);
      if (cf) return null;                 // samma riktade kant två gånger => icke-manifold
      edges.set(kf, 1);
    }
  }
  if (edges.size < 3) return null;

  /* utgående kanter per hörn */
  const outAdj = new Map();
  for (const key of edges.keys()) {
    const a = Math.floor(key / EDGE_SHIFT);
    const b = key - a * EDGE_SHIFT;
    if (outAdj.has(a)) return null;        // förgrening => hoppa över gruppen
    outAdj.set(a, b);
  }

  /* spåra slingor */
  const loops = [];
  const used = new Set();
  for (const startV of outAdj.keys()) {
    if (used.has(startV)) continue;
    const loop = [];
    let v = startV, guard = 0;
    while (guard++ <= outAdj.size + 1) {
      if (used.has(v)) { if (v === startV && loop.length) break; return null; }
      used.add(v); loop.push(v);
      const nx = outAdj.get(v);
      if (nx === undefined) return null;
      if (nx === startV) break;
      v = nx;
    }
    if (loop.length < 3) return null;
    loops.push(loop);
  }
  if (!loops.length) return null;
  if (used.size !== outAdj.size) return null;

  const n = [cluster[0].nx, cluster[0].ny, cluster[0].nz];
  const info = [];
  let sum = 0;
  for (const lp of loops) {
    const a = signedArea(pc, lp, n);
    sum += a;
    info.push({ loop: lp, area: a });
  }
  if (Math.abs(sum - areaSum) > Math.max(areaTol, Math.abs(areaSum) * 1e-6)) return null;

  const pos = info.filter(function (x) { return x.area > 0; });
  const neg = info.filter(function (x) { return x.area <= 0; });
  if (!pos.length) return null;

  const out = [];
  if (pos.length === 1) {
    out.push({ outer: simplify(pc, pos[0].loop), holes: neg.map(function (x) { return simplify(pc, x.loop); }) });
  } else {
    const ax = dominantAxis(n);
    void ax;
    const buckets = pos.map(function (p) { return { outer: p.loop, holes: [] }; });
    for (const h of neg) {
      let hit = -1;
      for (let k = 0; k < pos.length; k++) {
        if (pointInLoop(pc, h.loop[0], pos[k].loop, ax)) { if (hit >= 0) return null; hit = k; }
      }
      if (hit < 0) return null;
      buckets[hit].holes.push(h.loop);
    }
    for (const b of buckets) out.push({ outer: simplify(pc, b.outer), holes: b.holes.map(function (h) { return simplify(pc, h); }) });
  }
  for (const f of out) if (f.outer.length < 3) return null;
  return out;
}

function signedArea(pc, loop, n) {
  const X = pc.X, Y = pc.Y, Z = pc.Z;
  let cx = 0, cy = 0, cz = 0;
  const L = loop.length;
  for (let i = 0; i < L; i++) {
    const a = loop[i], b = loop[(i + 1) % L];
    cx += Y[a] * Z[b] - Z[a] * Y[b];
    cy += Z[a] * X[b] - X[a] * Z[b];
    cz += X[a] * Y[b] - Y[a] * X[b];
  }
  return 0.5 * (cx * n[0] + cy * n[1] + cz * n[2]);
}

function dominantAxis(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ax >= ay && ax >= az) return 0;
  return ay >= az ? 1 : 2;
}

function proj(pc, v, ax) {
  if (ax === 0) return [pc.Y[v], pc.Z[v]];
  if (ax === 1) return [pc.Z[v], pc.X[v]];
  return [pc.X[v], pc.Y[v]];
}

function pointInLoop(pc, v, loop, ax) {
  const p = proj(pc, v, ax);
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = proj(pc, loop[i], ax), b = proj(pc, loop[j], ax);
    if (((a[1] > p[1]) !== (b[1] > p[1])) &&
        (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) inside = !inside;
  }
  return inside;
}

/* ta bort kollineära hörn (arean är oförändrad) */
function simplify(pc, loop) {
  const X = pc.X, Y = pc.Y, Z = pc.Z;
  let cur = loop.slice();
  let changed = true;
  while (changed && cur.length > 3) {
    changed = false;
    const out = [];
    const L = cur.length;
    for (let i = 0; i < L; i++) {
      const p = cur[(i - 1 + L) % L], v = cur[i], q = cur[(i + 1) % L];
      const ax = X[v] - X[p], ay = Y[v] - Y[p], az = Z[v] - Z[p];
      const bx = X[q] - X[v], by = Y[q] - Y[v], bz = Z[q] - Z[v];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      const cross = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz);
      const dot = ax * bx + ay * by + az * bz;
      if (la > 0 && lb > 0 && cross <= 1e-9 * la * lb && dot > 0 && out.length + (L - i - 1) >= 3) {
        changed = true; continue;          // hoppa över v
      }
      out.push(v);
    }
    if (out.length < 3) break;
    cur = out;
  }
  return cur;
}

function emitLoopBound(m, st, pc, loop, boundType) {
  const ids = new Array(loop.length);
  for (let i = 0; i < loop.length; i++) ids[i] = '#' + m.ids[pc.owner[loop[i]]];
  /* observera: override-texten ar attributlistan UTAN yttre parenteser */
  const lp = addInstance(m, st, 'IFCPOLYLOOP', '(' + ids.join(',') + ')');
  const bd = addInstance(m, st, boundType, '#' + m.ids[lp] + ',.T.');
  return '#' + m.ids[bd];
}
