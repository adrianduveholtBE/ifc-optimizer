/* ==========================================================================
   30-strip.js  ·  borttagning, reparation av referenser, skräpsamling
   --------------------------------------------------------------------------
   Grundprincip: vi tar bara bort objekt vi vet hur vi lagar konsekvenserna
   av. För allt okänt "återuppstår" det borttagna objektet i stället — filen
   blir aldrig ogiltig, i värsta fall bara lite större än teoretiskt möjligt.
   ========================================================================== */

const GC_EXTRA_ROOTS = new Set(('IFCSTYLEDITEM IFCPRESENTATIONLAYERASSIGNMENT IFCPRESENTATIONLAYERWITHSTYLE ' +
  'IFCMATERIALDEFINITIONREPRESENTATION IFCSHAPEASPECT IFCMAPCONVERSION IFCPROJECTEDCRS ' +
  'IFCPRESENTATIONSTYLEASSIGNMENT').split(' '));

function isGcRoot(t, isRoot) {
  if (isRoot) return true;
  if (GC_EXTRA_ROOTS.has(t)) return true;
  if (t.endsWith('RELATIONSHIP')) return true;
  if (t.startsWith('IFCINDEXED') && t.endsWith('MAP')) return true;
  return false;
}

class StripState {
  constructor(m, roots) {
    this.m = m;
    this.roots = roots;
    this.alive = new Uint8Array(m.n).fill(1);
    this.override = new Map();      // idx -> ny attributtext (utan yttre parenteser)
    this.added = [];                // { type, params } — nya instanser
    this.killedBy = new Map();      // orsak -> antal
    this.killedType = new Map();    // typnamn -> antal
    this.resurrected = 0;
  }
  kill(i, why) {
    if (!this.alive[i]) return false;
    this.alive[i] = 0;
    this.killedBy.set(why, (this.killedBy.get(why) || 0) + 1);
    const t = this.m.typeOf(i);
    this.killedType.set(t, (this.killedType.get(t) || 0) + 1);
    return true;
  }
  revive(i) {
    if (this.alive[i]) return false;
    this.alive[i] = 1;
    this.resurrected++;
    const t = this.m.typeOf(i);
    const c = this.killedType.get(t);
    if (c) { if (c === 1) this.killedType.delete(t); else this.killedType.set(t, c - 1); }
    return true;
  }
  /* barnreferenser, med hänsyn till ev. överskriven attributtext */
  children(i, out) {
    out.length = 0;
    const ov = this.override.get(i);
    if (ov === undefined) {
      const m = this.m, a = m.refOff[i], b = m.refOff[i + 1];
      for (let k = a; k < b; k++) out.push(m.refIdx[k]);
      return out;
    }
    const m = this.m;
    for (let p = 0; p < ov.length; p++) {
      const c = ov.charCodeAt(p);
      if (c === CH_QUOTE) {
        p++;
        while (p < ov.length) {
          if (ov.charCodeAt(p) === CH_QUOTE) {
            if (p + 1 < ov.length && ov.charCodeAt(p + 1) === CH_QUOTE) { p += 2; continue; }
            break;
          }
          p++;
        }
        continue;
      }
      if (c === CH_HASH) {
        let q = p + 1, id = 0, nd = 0;
        while (q < ov.length) { const d = ov.charCodeAt(q); if (d < CH_0 || d > CH_9) break; id = id * 10 + (d - CH_0); q++; nd++; }
        if (nd > 0) { const t = m.idxOf(id); if (t >= 0) out.push(t); p = q - 1; }
      }
    }
    return out;
  }
}

/* --------------------------------------------------------------------------
   Bygg om attributtexten för instans i, med döda referenser borttagna.
   mode: 'kill' => tom obligatorisk lista signaleras, 'null' => blir $
   -------------------------------------------------------------------------- */
function pruneAttrs(m, st, i, mode) {
  const buf = m.buf, alive = st.alive;
  const attrs = [];
  const src = st.override.get(i);
  let parts;
  if (src !== undefined) {
    parts = splitStringAttrs(src);
  } else {
    splitAttrs(buf, m.pStart(i), m.pEnd(i), attrs);
    parts = [];
    for (let k = 0; k < attrs.length; k += 2) parts.push(ascii(buf, attrs[k], attrs[k + 1]));
  }

  let emptyList = false, deadSingle = false, changed = false;
  const out = new Array(parts.length);

  for (let a = 0; a < parts.length; a++) {
    const raw = parts[a];
    const s = raw.trim();
    if (s.length === 0) { out[a] = raw; continue; }
    if (s.charCodeAt(0) === CH_HASH) {
      const id = parseInt(s.slice(1), 10);
      const t = m.idxOf(id);
      if (t >= 0 && !alive[t]) {
        changed = true;
        if (mode === 'kill') { deadSingle = true; out[a] = raw; }
        else out[a] = '$';
        continue;
      }
      out[a] = raw; continue;
    }
    if (s.charCodeAt(0) === CH_LP) {
      const items = splitStringAttrs(s.slice(1, -1));
      const keep = [];
      let removed = false;
      for (const it of items) {
        const v = it.trim();
        if (v.charCodeAt(0) === CH_HASH) {
          const id = parseInt(v.slice(1), 10);
          const t = m.idxOf(id);
          if (t >= 0 && !alive[t]) { removed = true; continue; }
        }
        keep.push(it);
      }
      if (removed) {
        changed = true;
        if (keep.length === 0) {
          if (mode === 'kill') { emptyList = true; out[a] = s; }
          else out[a] = '$';
        } else out[a] = '(' + keep.join(',') + ')';
        continue;
      }
      out[a] = raw; continue;
    }
    out[a] = raw;
  }

  return { text: out.join(','), changed, emptyList, deadSingle };
}

/* dela en attributsträng på kommatecken i toppnivå */
function splitStringAttrs(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_QUOTE) {
      i++;
      while (i < s.length) {
        if (s.charCodeAt(i) === CH_QUOTE) {
          if (i + 1 < s.length && s.charCodeAt(i + 1) === CH_QUOTE) { i++; }
          else break;
        }
        i++;
      }
      continue;
    }
    if (c === CH_LP) depth++;
    else if (c === CH_RP) depth--;
    else if (c === CH_COMMA && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/* finns döda referenser kvar i texten? */
function hasDeadRef(m, st, text) {
  for (let p = 0; p < text.length; p++) {
    const c = text.charCodeAt(p);
    if (c === CH_QUOTE) {
      p++;
      while (p < text.length) {
        if (text.charCodeAt(p) === CH_QUOTE) {
          if (p + 1 < text.length && text.charCodeAt(p + 1) === CH_QUOTE) { p += 2; continue; }
          break;
        }
        p++;
      }
      continue;
    }
    if (c === CH_HASH) {
      let q = p + 1, id = 0, nd = 0;
      while (q < text.length) { const d = text.charCodeAt(q); if (d < CH_0 || d > CH_9) break; id = id * 10 + (d - CH_0); q++; nd++; }
      if (nd > 0) {
        const t = m.idxOf(id);
        if (t >= 0 && !st.alive[t]) return true;
        p = q - 1;
      }
    }
  }
  return false;
}

/* --------------------------------------------------------------------------
   Steg 1: markera vad som ska bort enligt inställningarna
   -------------------------------------------------------------------------- */
function markDeaths(m, st, o, log) {
  const roots = st.roots;
  const n = m.n;
  const dropClasses = o.dropClasses && o.dropClasses.length
    ? new Set(o.dropClasses.map(function (x) { return x.toUpperCase(); })) : null;

  /* beslut per typ (bara ~100 typer) i stället för per instans */
  const nt = m.typeNames.length;
  const decision = new Uint8Array(nt);   // 0=behåll 1=klass 2=typobjekt 3=urval
  for (let t = 1; t < nt; t++) {
    const name = m.typeNames[t];
    if (dropClasses && dropClasses.has(name)) { decision[t] = 1; continue; }
    if (o.dropTypes && name.endsWith('TYPE') && !name.startsWith('IFCREL')) { decision[t] = 2; continue; }
    if (inDropSet(name, o)) { decision[t] = 3; continue; }
  }
  const WHY = ['', 'klass', 'typobjekt', 'urval'];
  for (let i = 0; i < n; i++) {
    const d = decision[m.tId[i]];
    if (d === 0) continue;
    if (d === 2 && !roots[i]) continue;      // typobjekt måste vara rotobjekt
    st.kill(i, WHY[d]);
  }

  /* 2D-representationer: kolla identifierare och representationstyp */
  if (o.drop2D) {
    const attrs = [];
    for (let i = 0; i < n; i++) {
      if (!st.alive[i]) continue;
      const t = m.typeOf(i);
      if (t !== 'IFCSHAPEREPRESENTATION' && t !== 'IFCTOPOLOGYREPRESENTATION') continue;
      splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
      if (attrs.length < 8) continue;
      const ident = quotedAt(m.buf, attrs[2], attrs[3]);
      const rtype = quotedAt(m.buf, attrs[4], attrs[5]);
      const iu = ident ? ident.toUpperCase().replace(/[\s_-]/g, '') : '';
      const ru = rtype ? rtype.toUpperCase().replace(/[\s_-]/g, '') : '';
      if ((iu && DROP_REP_IDENT.has(iu)) || (ru && DROP_REP_TYPE.has(ru))) st.kill(i, '2D-representation');
    }
  }

  /* Rum: flytta upp innehållet till våningen innan rummet tas bort */
  if (o.dropSpaces) reparentSpaces(m, st, log);
}

function reparentSpaces(m, st, log) {
  const n = m.n, attrs = [];
  const parentOf = new Map();          // rumsindex -> förälderindex
  for (let i = 0; i < n; i++) {
    if (m.typeOf(i) !== 'IFCRELAGGREGATES') continue;
    splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
    if (attrs.length < 12) continue;
    const rel = refAt(m, attrs[8], attrs[9]);
    if (rel < 0) continue;
    const kids = refListAt(m, attrs[10], attrs[11]);
    for (const k of kids) if (!st.alive[k] && m.typeOf(k) === 'IFCSPACE') parentOf.set(k, rel);
  }
  if (parentOf.size === 0) return;

  let moved = 0;
  for (let i = 0; i < n; i++) {
    if (!st.alive[i]) continue;
    const t = m.typeOf(i);
    if (t === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') {
      splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
      if (attrs.length < 12) continue;
      const struct = refAt(m, attrs[10], attrs[11]);
      if (struct >= 0 && parentOf.has(struct)) {
        const p = parentOf.get(struct);
        let chain = 0;
        let target = p;
        while (!st.alive[target] && parentOf.has(target) && chain++ < 16) target = parentOf.get(target);
        if (!st.alive[target]) continue;
        const parts = [];
        for (let k = 0; k < attrs.length; k += 2) parts.push(ascii(m.buf, attrs[k], attrs[k + 1]));
        parts[5] = '#' + m.ids[target];
        st.override.set(i, parts.join(','));
        moved++;
      }
    } else if (t === 'IFCRELAGGREGATES') {
      splitAttrs(m.buf, m.pStart(i), m.pEnd(i), attrs);
      if (attrs.length < 12) continue;
      const rel = refAt(m, attrs[8], attrs[9]);
      if (rel >= 0 && parentOf.has(rel)) {
        let target = parentOf.get(rel), chain = 0;
        while (!st.alive[target] && parentOf.has(target) && chain++ < 16) target = parentOf.get(target);
        if (!st.alive[target]) continue;
        const parts = [];
        for (let k = 0; k < attrs.length; k += 2) parts.push(ascii(m.buf, attrs[k], attrs[k + 1]));
        parts[4] = '#' + m.ids[target];
        st.override.set(i, parts.join(','));
        moved++;
      }
    }
  }
  if (moved && log) log('Flyttade ' + fmtNum(moved) + ' relationer från rum till våningsplan.');
}

/* --------------------------------------------------------------------------
   Steg 2: reparera referenser till fixpunkt
   -------------------------------------------------------------------------- */
function repairRefs(m, st, log, prog) {
  const roots = st.roots;
  const n = m.n;
  let round = 0;
  const kids = [];
  for (;;) {
    round++;
    /* samla alla levande föräldrar som pekar på något dött */
    const todo = new Set();
    for (let i = 0; i < n; i++) {
      if (st.alive[i]) continue;
      const a = m.parOff[i], b = m.parOff[i + 1];
      for (let k = a; k < b; k++) { const p = m.parIdx[k]; if (st.alive[p]) todo.add(p); }
    }
    /* överskrivna instanser kan ha nya referenser — kolla dem också */
    for (const i of st.override.keys()) {
      if (!st.alive[i]) continue;
      st.children(i, kids);
      for (const c of kids) if (!st.alive[c]) { todo.add(i); break; }
    }
    if (todo.size === 0) break;

    let changes = 0;
    for (const p of todo) {
      if (!st.alive[p]) continue;
      const t = m.typeOf(p);
      const act = actionFor(t, !!roots[p]);
      if (act === ACT_KILL) { if (st.kill(p, 'kedja')) changes++; continue; }
      if (act === ACT_RESURRECT) {
        st.children(p, kids);
        const list = kids.slice();
        for (const c of list) if (!st.alive[c]) { if (reviveTree(m, st, c)) changes++; }
        continue;
      }
      const mode = (act === ACT_PRUNE_KILL) ? 'kill' : 'null';
      const r = pruneAttrs(m, st, p, mode);
      if (mode === 'kill' && (r.emptyList || r.deadSingle)) { if (st.kill(p, 'kedja')) changes++; continue; }
      if (r.changed) {
        if (hasDeadRef(m, st, r.text)) {
          /* något vi inte förstod ligger djupare — väck det i stället */
          st.children(p, kids);
          const list = kids.slice();
          for (const c of list) if (!st.alive[c]) { if (reviveTree(m, st, c)) changes++; }
        } else {
          st.override.set(p, r.text);
          changes++;
        }
      }
    }
    if (prog) prog(Math.min(0.95, round / 6));
    if (changes === 0) break;
    if (round > 40) { if (log) log('Varning: reparationen nådde rundgräns.'); break; }
  }
}

/* väck ett dött objekt och allt det pekar på */
function reviveTree(m, st, start) {
  if (st.alive[start]) return false;
  const stack = [start];
  let any = false;
  const kids = [];
  while (stack.length) {
    const i = stack.pop();
    if (st.alive[i]) continue;
    st.revive(i); any = true;
    st.children(i, kids);
    for (const c of kids) if (!st.alive[c]) stack.push(c);
  }
  return any;
}

/* --------------------------------------------------------------------------
   Steg 3: skräpsamling — allt som inte nås från ett rotobjekt
   -------------------------------------------------------------------------- */
function collectGarbage(m, st, log, prog) {
  const roots = st.roots;
  const n = m.n;
  const seen = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (!st.alive[i]) continue;
    if (isGcRoot(m.typeOf(i), !!roots[i])) { seen[i] = 1; stack.push(i); }
  }
  const kids = [];
  let processed = 0;
  while (stack.length) {
    const i = stack.pop();
    processed++;
    const ov = st.override.get(i);
    if (ov === undefined) {
      const a = m.refOff[i], b = m.refOff[i + 1];
      for (let k = a; k < b; k++) {
        const c = m.refIdx[k];
        if (!seen[c] && st.alive[c]) { seen[c] = 1; stack.push(c); }
      }
    } else {
      st.children(i, kids);
      for (const c of kids) if (!seen[c] && st.alive[c]) { seen[c] = 1; stack.push(c); }
    }
    if (prog && (processed & 0xFFFF) === 0) prog(Math.min(0.9, processed / n));
  }
  /* Säkerhetsnät: skräpsamlingen bygger helt på att rotobjekten hittades.
     Hittades inte ens IfcProject som rotobjekt är något fel med filen (eller
     med vår igenkänning) och då rör vi ingenting. */
  let aliveBefore = 0, wouldRemove = 0;
  for (let i = 0; i < n; i++) {
    if (!st.alive[i]) continue;
    aliveBefore++;
    if (!seen[i]) wouldRemove++;
  }
  const tProj = m.typeIds.get('IFCPROJECT');
  let projOk = (tProj === undefined);
  if (!projOk) {
    for (let i = 0; i < n; i++) {
      if (m.tId[i] === tProj && roots[i]) { projOk = true; break; }
    }
  }
  if (!projOk || wouldRemove > aliveBefore * 0.9) {
    if (log) {
      log('VARNING: skräpsamlingen hoppas över — modellens rotobjekt kunde inte ' +
          'kännas igen (' + fmtNum(wouldRemove) + ' av ' + fmtNum(aliveBefore) +
          ' objekt hade tagits bort). Filen lämnas hellre större än trasig.');
    }
    return 0;
  }
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (st.alive[i] && !seen[i]) { st.kill(i, 'föräldralös'); removed++; }
  }
  if (log && removed) log('Skräpsamling: ' + fmtNum(removed) + ' oanvända objekt bort.');
  return removed;
}
