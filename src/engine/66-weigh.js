/* ==========================================================================
   66-weigh.js  ·  vad väger varje familj och klass — i vilken fil som helst
   --------------------------------------------------------------------------
   Djupanalysen i 76 behöver hela referensgrafen i minnet och tar därför slut
   vid några hundra megabyte. Den här gör samma jobb strömmande.

   Tricket: i en IFC pekar referenser nästan alltid bakåt, mot lägre
   instansnummer — barnen skrivs före föräldern. (Mätt på en Revit-modell:
   99,97 % av referenserna.) Då räcker det att gå igenom filen *baklänges*:
   när vi möter en byggdel vet vi vem den är, och kan stämpla allt den pekar
   på med samma ägare innan vi kommer dit.

   Minnet blir 2 byte per instansnummer i stället för en hel graf.
   ========================================================================== */

const WEIGH_CHUNK = 32 * 1048576;

/* Läs igenom statements i [from,to). cb(start, end, idStart, idEnd, typeStart,
   typeEnd, paramStart, paramEnd). Returnerar offseten efter sista hela
   statement. */
function scanStatements(buf, from, to, cb) {
  let p = from, last = from;
  while (p < to) {
    p = skipWs(buf, p, to);
    if (p >= to) break;
    if (buf[p] !== CH_HASH) { p++; continue; }
    const s = p;
    let q = p + 1, nd = 0;
    while (q < to && isDigit(buf[q])) { q++; nd++; }
    if (nd === 0) { p++; continue; }
    const idEnd = q;
    q = skipWs(buf, q, to);
    if (q >= to || buf[q] !== CH_EQ) { p = q > p ? q : p + 1; continue; }
    q = skipWs(buf, q + 1, to);
    const tS = q;
    while (q < to && isNameChar(buf[q])) q++;
    const tE = q;
    q = skipWs(buf, q, to);
    if (q >= to || buf[q] !== CH_LP) { p = q > p ? q : p + 1; continue; }
    const close = skipGroup(buf, q, to);
    if (close < 0) break;
    let e = skipWs(buf, close, to);
    if (e < to && buf[e] === CH_SEMI) e++;
    cb(s, e, p + 1, idEnd, tS, tE, q, close);
    last = e;
    p = e;
  }
  return last;
}

/* "IFCREL..." utan att bygga en sträng */
const SEQ_IFCREL = [73, 70, 67, 82, 69, 76];   // IFCREL i versaler
function startsWithIfcRel(buf, from, to) {
  if (to - from < 6) return false;
  for (let i = 0; i < 6; i++) {
    let c = buf[from + i];
    if (c >= CH_a && c <= CH_z) c -= 32;
    if (c !== SEQ_IFCREL[i]) return false;
  }
  return true;
}

function readUint(buf, from, to) {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 10 + (buf[i] - CH_0);
  return v;
}

/* Familjenamnet ur Revits objektnamn: "Vägg:Betong 200:123456" -> "Vägg:Betong 200" */
function familyFromName(name) {
  if (!name) return '';
  const s = String(name);
  const m = /^(.*):(\d+)$/.exec(s);
  return (m ? m[1] : s).trim();
}

/* --------------------------------------------------------------------------
   weighByOwner — två strömmande pass
   -------------------------------------------------------------------------- */
async function weighByOwner(file, hooks) {
  const prog = (hooks && hooks.prog) || function () {};
  const log = (hooks && hooks.log) || function () {};
  const size = file.size;

  /* ---- pass 1: hitta högsta instansnummer och ankare per block ---- */
  const anchors = [];            // offset till första hela statement i varje block
  let maxId = 0, instances = 0, dataStart = 0, dataEnd = size;

  {
    const head = new Uint8Array(await file.slice(0, Math.min(size, 4 * 1048576)).arrayBuffer());
    const at = findSeq(head, SEQ_DATA, 0, head.length);
    if (at < 0) throw new Error('Hittar ingen DATA-sektion.');
    dataStart = at + SEQ_DATA.length;
  }

  let pos = dataStart;
  let carry = null, carryAt = 0;
  while (pos < size) {
    const end = Math.min(size, pos + WEIGH_CHUNK);
    const chunk = new Uint8Array(await file.slice(pos, end).arrayBuffer());
    let buf, base;
    if (carry && carry.length) {
      buf = new Uint8Array(carry.length + chunk.length);
      buf.set(carry, 0); buf.set(chunk, carry.length);
      base = carryAt;
    } else { buf = chunk; base = pos; }

    let first = -1;
    const consumed = scanStatements(buf, 0, buf.length, function (s, e, idS, idE) {
      if (first < 0) { first = base + s; }
      const id = readUint(buf, idS, idE);
      if (id > maxId) maxId = id;
      instances++;
    });
    if (first >= 0) anchors.push(first);
    carry = consumed < buf.length ? buf.slice(consumed) : null;
    carryAt = base + consumed;
    pos = end;
    prog('Läser igenom filen', 0.05 + 0.35 * (pos / size));
  }
  dataEnd = carryAt;
  if (!anchors.length) throw new Error('Hittade inga instanser.');
  anchors.push(dataEnd);

  if (maxId > 200000000) throw new Error('Instansnumren är orimligt höga (' + fmtNum(maxId) + ').');

  /* ---- pass 2: baklänges, stämpla ägare och räkna byte ---- */
  const ownerOf = new Uint16Array(maxId + 2);     // 0 = ingen ägare
  const owners = [null];                          // plats 0 används inte
  const ownerKey = new Map();
  const bytes = [0];
  const counts = [0];
  let unowned = 0, overflow = 0;

  const slotFor = function (cls, family) {
    const key = cls + '|' + family;
    let s = ownerKey.get(key);
    if (s === undefined) {
      if (owners.length >= 65500) { overflow++; return 1; }
      s = owners.length;
      owners.push({ cls: cls, family: family });
      bytes.push(0); counts.push(0);
      ownerKey.set(key, s);
    }
    return s;
  };
  slotFor('(övrigt)', '');

  const attrs = [];
  for (let k = anchors.length - 2; k >= 0; k--) {
    const lo = anchors[k], hi = anchors[k + 1];
    const buf = new Uint8Array(await file.slice(lo, hi).arrayBuffer());
    const stmts = [];
    scanStatements(buf, 0, buf.length, function (s, e, idS, idE, tS, tE, pS, pE) {
      stmts.push(s, e, idS, idE, tS, tE, pS, pE);
    });

    for (let j = stmts.length - 8; j >= 0; j -= 8) {
      const s = stmts[j], e = stmts[j + 1], idS = stmts[j + 2], idE = stmts[j + 3];
      const tS = stmts[j + 4], tE = stmts[j + 5], pS = stmts[j + 6], pE = stmts[j + 7];
      const id = readUint(buf, idS, idE);
      let slot = id <= maxId ? ownerOf[id] : 0;

      if (slot === 0) {
        /* Kan det vara en byggdel? Billig förkontroll: attribut 1 är en sträng.
           Relationer ser likadana ut — IfcRelAssignsToGroup har också sju
           attribut där det sjunde är en referens — och eftersom de skrivs sist
           i filen skulle de annars stämpla hela modellen som sin. Därför
           utesluts IFCREL* uttryckligen. */
        let c = skipWs(buf, pS + 1, pE);
        if (buf[c] === CH_QUOTE && !startsWithIfcRel(buf, tS, tE)) {
          splitAttrs(buf, pS + 1, pE, attrs);
          /* IfcProduct: GlobalId, OwnerHistory, Name, Description, ObjectType,
             ObjectPlacement, Representation */
          if (attrs.length >= 14) {
            const rt = trimRange(buf, attrs[12], attrs[13]);
            if (buf[rt[0]] === CH_HASH && rt[1] - rt[0] > 1) {
              const cls = ascii(buf, tS, tE).toUpperCase();
              if (!cls.endsWith('TYPE')) {
                let nm = quotedAt(buf, attrs[4], attrs[5]);
                if (!nm) nm = quotedAt(buf, attrs[8], attrs[9]);   // ObjectType
                slot = slotFor(cls, familyFromName(nm));
                if (id <= maxId) ownerOf[id] = slot;
                counts[slot]++;
              }
            }
          }
        }
      }

      if (slot !== 0) {
        bytes[slot] += (e - s);
        /* stämpla allt den pekar på */
        let p = pS;
        while (p < pE) {
          const ch = buf[p];
          if (ch === CH_QUOTE) { p = skipQuotedFrom(buf, p, pE); continue; }
          if (ch === CH_HASH) {
            let q = p + 1, v = 0, n2 = 0;
            while (q < pE && isDigit(buf[q])) { v = v * 10 + (buf[q] - CH_0); q++; n2++; }
            if (n2 > 0) {
              if (v <= maxId && ownerOf[v] === 0) ownerOf[v] = slot;
              p = q; continue;
            }
          }
          p++;
        }
      } else {
        unowned += (e - s);
      }
    }
    prog('Väger objekten', 0.4 + 0.55 * (1 - k / anchors.length));
  }

  const list = [];
  for (let s = 1; s < owners.length; s++) {
    if (!bytes[s]) continue;
    list.push({
      cls: owners[s].cls, family: owners[s].family,
      count: counts[s], bytes: bytes[s],
      perObject: counts[s] ? bytes[s] / counts[s] : bytes[s]
    });
  }
  list.sort(function (a, b) { return b.bytes - a.bytes; });

  /* per klass */
  const byCls = new Map();
  for (const o of list) {
    let c = byCls.get(o.cls);
    if (!c) { c = { cls: o.cls, bytes: 0, count: 0, families: 0 }; byCls.set(o.cls, c); }
    c.bytes += o.bytes; c.count += o.count; c.families++;
  }
  const classes = Array.from(byCls.values()).sort(function (a, b) { return b.bytes - a.bytes; });
  for (const c of classes) c.perObject = c.count ? c.bytes / c.count : c.bytes;

  if (overflow) log('Fler än 65 000 olika familjer — de sista slogs ihop under "(övrigt)".');
  log('Vägning klar: ' + fmtNum(instances) + ' instanser, ' + fmtNum(list.length) +
      ' familjer, ' + fmtBytes(unowned) + ' kunde inte knytas till någon byggdel.');

  return {
    families: list.slice(0, 200), classes: classes, instances: instances,
    unowned: unowned, owned: size - unowned, streamed: true
  };
}
