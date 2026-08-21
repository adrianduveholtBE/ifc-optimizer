/* ==========================================================================
   62-tess.js  ·  tessellerad geometri (IFC4) + omslutande lådor
   --------------------------------------------------------------------------
   weldPointLists  — kvantiserar och svetsar ihop sammanfallande hörn i
                     IfcCartesianPointList och räknar om indexlistorna.
   boxifyGeometry  — byter ut mesh / BREP mot en extruderad låda (aggressivt).
   ========================================================================== */

/* läs en talmatris "((1.,2.,3.),(4.,5.,6.))" -> {rows:[[..]], ok} */
function readCoordList(m, i) {
  const buf = m.buf;
  const attrs = [];
  splitAttrs(buf, m.pStart(i), m.pEnd(i), attrs);
  if (attrs.length < 2) return null;
  const t = trimRange(buf, attrs[0], attrs[1]);
  if (buf[t[0]] !== CH_LP) return null;
  const items = [];
  splitAttrs(buf, t[0] + 1, t[1] - 1, items);
  const rows = new Array(items.length / 2);
  for (let k = 0; k < items.length; k += 2) {
    const r = trimRange(buf, items[k], items[k + 1]);
    if (buf[r[0]] !== CH_LP) return null;
    const nums = [];
    splitAttrs(buf, r[0] + 1, r[1] - 1, nums);
    const row = new Array(nums.length / 2);
    for (let q = 0; q < nums.length; q += 2) row[q / 2] = parseFloat(attrText(m, nums[q], nums[q + 1])) || 0;
    rows[k / 2] = row;
  }
  return rows;
}

/* läs en heltalsmatris "((1,2,3),(4,5,6))" */
function readIndexList(m, i, attrIndex) {
  const buf = m.buf;
  const attrs = [];
  splitAttrs(buf, m.pStart(i), m.pEnd(i), attrs);
  if (attrs.length < (attrIndex + 1) * 2) return null;
  const t = trimRange(buf, attrs[attrIndex * 2], attrs[attrIndex * 2 + 1]);
  if (buf[t[0]] !== CH_LP) return null;
  const items = [];
  splitAttrs(buf, t[0] + 1, t[1] - 1, items);
  const rows = [];
  for (let k = 0; k < items.length; k += 2) {
    const r = trimRange(buf, items[k], items[k + 1]);
    if (buf[r[0]] === CH_LP) {
      const nums = [];
      splitAttrs(buf, r[0] + 1, r[1] - 1, nums);
      const row = new Array(nums.length / 2);
      for (let q = 0; q < nums.length; q += 2) row[q / 2] = parseInt(attrText(m, nums[q], nums[q + 1]), 10);
      rows.push(row);
    } else {
      rows.push([parseInt(attrText(m, r[0], r[1]), 10)]);
    }
  }
  return rows;
}

function fmtRows(rows, dec) {
  const parts = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = new Array(r.length);
    for (let k = 0; k < r.length; k++) p[k] = fmtReal(r[k], dec);
    parts[i] = '(' + p.join(',') + ')';
  }
  return '(' + parts.join(',') + ')';
}
function fmtIntRows(rows) {
  const parts = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) parts[i] = '(' + rows[i].join(',') + ')';
  return '(' + parts.join(',') + ')';
}

/* --------------------------------------------------------------------------
   Svetsning av punktlistor
   -------------------------------------------------------------------------- */
function weldPointLists(m, st, o, log, prog) {
  const res = { lists: 0, before: 0, after: 0, degenerate: 0 };
  const tPL3 = m.typeIds.get('IFCCARTESIANPOINTLIST3D');
  if (tPL3 === undefined) return res;
  const dec = o.weldDec !== undefined && o.weldDec !== null ? o.weldDec : o.coordDec;
  const attrs = [];

  const lists = [];
  for (let i = 0; i < m.n; i++) if (st.alive[i] && m.tId[i] === tPL3) lists.push(i);
  if (!lists.length) return res;

  for (let li = 0; li < lists.length; li++) {
    const pl = lists[li];
    const rows = readCoordList(m, pl);
    if (!rows || rows.length < 4) continue;

    /* vilka konsumenter finns? bara svetsa när vi förstår alla */
    const parents = [];
    const a = m.parOff[pl], b = m.parOff[pl + 1];
    let understood = true;
    for (let k = a; k < b; k++) {
      const p = m.parIdx[k];
      if (!st.alive[p]) continue;
      const t = m.typeOf(p);
      if (t === 'IFCTRIANGULATEDFACESET' || t === 'IFCPOLYGONALFACESET') parents.push(p);
      else { understood = false; break; }
    }
    if (!understood || !parents.length) continue;

    /* PnIndex gör indexeringen indirekt — då rör vi den inte */
    let indirect = false;
    for (const p of parents) {
      splitAttrs(m.buf, m.pStart(p), m.pEnd(p), attrs);
      const t = m.typeOf(p);
      const pnAt = (t === 'IFCTRIANGULATEDFACESET') ? 4 : 3;
      if (attrs.length >= (pnAt + 1) * 2) {
        const tx = attrText(m, attrs[pnAt * 2], attrs[pnAt * 2 + 1]);
        if (tx !== '$' && tx !== '') indirect = true;
      }
    }
    if (indirect) continue;

    const scale = Math.pow(10, dec);
    const seen = new Map();
    const remap = new Int32Array(rows.length + 1);
    const kept = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const x = Math.round((row[0] || 0) * scale) / scale;
      const y = Math.round((row[1] || 0) * scale) / scale;
      const z = Math.round((row[2] || 0) * scale) / scale;
      const key = x + ',' + y + ',' + z;
      let at = seen.get(key);
      if (at === undefined) { kept.push([x, y, z]); at = kept.length; seen.set(key, at); }
      remap[r + 1] = at;
    }
    if (kept.length === rows.length) continue;      // inget att vinna

    res.lists++; res.before += rows.length; res.after += kept.length;
    st.override.set(pl, fmtRows(kept, dec));

    for (const p of parents) {
      const t = m.typeOf(p);
      const parts = [];
      splitAttrs(m.buf, m.pStart(p), m.pEnd(p), attrs);
      for (let k = 0; k < attrs.length; k += 2) parts.push(ascii(m.buf, attrs[k], attrs[k + 1]));
      if (t === 'IFCTRIANGULATEDFACESET') {
        const idx = readIndexList(m, p, 3);
        if (!idx) continue;
        const out = [];
        for (const tri of idx) {
          const A = remap[tri[0]], B = remap[tri[1]], C = remap[tri[2]];
          if (A === B || B === C || A === C) { res.degenerate++; continue; }
          out.push([A, B, C]);
        }
        if (!out.length) continue;
        parts[3] = fmtIntRows(out);
        st.override.set(p, parts.join(','));
      } else {
        /* IfcPolygonalFaceSet: indexen sitter i IfcIndexedPolygonalFace */
        const faces = refListAt(m, attrs[4], attrs[5]);
        for (const f of faces) {
          if (!st.alive[f]) continue;
          const fidx = readIndexList(m, f, 0);
          if (!fidx || !fidx.length) continue;
          const flat = fidx[0];
          const out = [];
          for (const v of flat) {
            const nv = remap[v];
            if (out.length === 0 || out[out.length - 1] !== nv) out.push(nv);
          }
          while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
          if (out.length < 3) { st.kill(f, 'urartad yta'); res.degenerate++; continue; }
          const fparts = [];
          const fa = [];
          splitAttrs(m.buf, m.pStart(f), m.pEnd(f), fa);
          for (let k = 0; k < fa.length; k += 2) fparts.push(ascii(m.buf, fa[k], fa[k + 1]));
          fparts[0] = '(' + out.join(',') + ')';
          st.override.set(f, fparts.join(','));
        }
      }
    }
    if (prog) prog(li / lists.length);
  }
  if (log && res.lists) {
    log('Svetsade hörn: ' + fmtNum(res.before) + ' -> ' + fmtNum(res.after) +
        ' punkter i ' + fmtNum(res.lists) + ' listor.');
  }
  return res;
}

/* --------------------------------------------------------------------------
   Omslutande låda i stället för mesh/BREP
   -------------------------------------------------------------------------- */
function boxifyGeometry(m, st, o, log, prog) {
  const res = { replaced: 0, skipped: 0 };
  const dec = o.coordDec;
  const minDim = Math.pow(10, -dec) * 10;
  const pc = buildPointCache(m, st, o, null);

  const targets = [];
  for (let i = 0; i < m.n; i++) {
    if (!st.alive[i]) continue;
    const t = m.typeOf(i);
    if (t === 'IFCTRIANGULATEDFACESET' || t === 'IFCPOLYGONALFACESET' || t === 'IFCFACETEDBREP') targets.push(i);
  }
  if (!targets.length) return res;

  const attrs = [];
  for (let k = 0; k < targets.length; k++) {
    const g = targets[k];
    const t = m.typeOf(g);
    let box = null;
    if (t === 'IFCFACETEDBREP') box = bboxOfBrep(m, st, pc, g);
    else box = bboxOfFaceSet(m, g);
    if (!box) { res.skipped++; continue; }

    const dx = Math.max(box[3] - box[0], minDim);
    const dy = Math.max(box[4] - box[1], minDim);
    const dz = Math.max(box[5] - box[2], minDim);
    const cx = (box[0] + box[3]) / 2, cy = (box[1] + box[4]) / 2;

    /* override-texten ar attributlistan UTAN yttre parenteser */
    const p2 = addInstance(m, st, 'IFCCARTESIANPOINT', '(' + fmtReal(cx, dec) + ',' + fmtReal(cy, dec) + ')');
    const ax2 = addInstance(m, st, 'IFCAXIS2PLACEMENT2D', '#' + m.ids[p2] + ',$');
    const prof = addInstance(m, st, 'IFCRECTANGLEPROFILEDEF',
      '.AREA.,$,#' + m.ids[ax2] + ',' + fmtReal(dx, dec) + ',' + fmtReal(dy, dec));
    const p3 = addInstance(m, st, 'IFCCARTESIANPOINT',
      '(' + fmtReal(0, dec) + ',' + fmtReal(0, dec) + ',' + fmtReal(box[2], dec) + ')');
    const ax3 = addInstance(m, st, 'IFCAXIS2PLACEMENT3D', '#' + m.ids[p3] + ',$,$');
    const dir = addInstance(m, st, 'IFCDIRECTION', '(0.,0.,1.)');
    const sol = addInstance(m, st, 'IFCEXTRUDEDAREASOLID',
      '#' + m.ids[prof] + ',#' + m.ids[ax3] + ',#' + m.ids[dir] + ',' + fmtReal(dz, dec));

    /* byt ut referensen i alla föräldrar och rätta representationstypen */
    const a = m.parOff[g], b = m.parOff[g + 1];
    let used = false;
    for (let x = a; x < b; x++) {
      const p = m.parIdx[x];
      if (!st.alive[p]) continue;
      const pt = m.typeOf(p);
      const parts = [];
      splitAttrs(m.buf, m.pStart(p), m.pEnd(p), attrs);
      for (let q = 0; q < attrs.length; q += 2) parts.push(ascii(m.buf, attrs[q], attrs[q + 1]));
      const oldRef = '#' + m.ids[g], newRef = '#' + m.ids[sol];
      let hit = false;
      for (let q = 0; q < parts.length; q++) {
        if (parts[q].indexOf(oldRef) < 0) continue;
        const re = new RegExp('#' + m.ids[g] + '(?![0-9])', 'g');
        const next = parts[q].replace(re, newRef);
        if (next !== parts[q]) { parts[q] = next; hit = true; }
      }
      if (!hit) continue;
      if (pt === 'IFCSHAPEREPRESENTATION' && parts.length >= 3) parts[2] = "'SweptSolid'";
      st.override.set(p, parts.join(','));
      used = true;
    }
    if (!used) { res.skipped++; continue; }
    st.kill(g, 'ersatt av låda');
    res.replaced++;
    if (prog) prog(k / targets.length);
  }
  if (log && res.replaced) log('Ersatte ' + fmtNum(res.replaced) + ' geometrier med omslutande låda.');
  return res;
}

function bboxOfFaceSet(m, g) {
  const attrs = [];
  splitAttrs(m.buf, m.pStart(g), m.pEnd(g), attrs);
  const coords = refAt(m, attrs[0], attrs[1]);
  if (coords < 0) return null;
  const rows = readCoordList(m, coords);
  if (!rows || !rows.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const r of rows) {
    const x = r[0] || 0, y = r[1] || 0, z = r[2] || 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

function bboxOfBrep(m, st, pc, g) {
  const seen = new Set();
  const stack = [g];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  let found = 0, guard = 0;
  while (stack.length && guard++ < 4000000) {
    const i = stack.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const sl = pc.slot[i];
    if (sl >= 0) {
      const x = pc.X[sl], y = pc.Y[sl], z = pc.Z[sl];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      found++;
      continue;
    }
    const a = m.refOff[i], b = m.refOff[i + 1];
    for (let k = a; k < b; k++) stack.push(m.refIdx[k]);
  }
  if (found < 4) return null;
  return [x0, y0, z0, x1, y1, z1];
}
