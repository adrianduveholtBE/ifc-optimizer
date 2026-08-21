#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Oberoende kontroll av en IFC-fil (och jamforelse fore/efter optimering).

  python tools/verify.py fil.ifc
  python tools/verify.py fore.ifc efter.ifc

Kontrollerar syntax, brutna referenser, dubbletter av instansnummer och
raknar ut area + volym for alla slutna skal sa att geometrin kan jamforas
mellan tva filer. Skriver bara aggregerade siffror - aldrig modellinnehall.
"""
import io, os, re, sys, math, collections

STMT = re.compile(rb'#(\d+)\s*=\s*([A-Za-z0-9_]*)\s*\(')

def read(path):
    data = open(path, 'rb').read()
    ents = {}
    order = []
    dup = 0
    i = data.find(b'DATA;')
    end = data.rfind(b'ENDSEC;')
    if i < 0:
        raise SystemExit('%s: ingen DATA-sektion' % path)
    for m in STMT.finditer(data, i, end if end > 0 else len(data)):
        sid = int(m.group(1)); typ = m.group(2).upper().decode('ascii')
        j = m.end() - 1
        depth = 0; inq = False
        n = len(data)
        while j < n:
            c = data[j]
            if inq:
                if c == 39:
                    if j + 1 < n and data[j + 1] == 39:
                        j += 1
                    else:
                        inq = False
            else:
                if c == 39: inq = True
                elif c == 40: depth += 1
                elif c == 41:
                    depth -= 1
                    if depth == 0:
                        j += 1; break
            j += 1
        params = data[m.end():j - 1]
        if sid in ents: dup += 1
        ents[sid] = (typ, params)
        order.append(sid)
    return data, ents, order, dup

def refs_of(params):
    out = []
    i = 0; n = len(params)
    while i < n:
        c = params[i]
        if c == 39:
            i += 1
            while i < n:
                if params[i] == 39:
                    if i + 1 < n and params[i + 1] == 39: i += 2; continue
                    i += 1; break
                i += 1
            continue
        if c == 35:
            j = i + 1; v = 0; nd = 0
            while j < n and 48 <= params[j] <= 57:
                v = v * 10 + params[j] - 48; j += 1; nd += 1
            if nd: out.append(v); i = j; continue
        i += 1
    return out

def top_items(params):
    """dela pa kommatecken i toppnivan"""
    out = []; depth = 0; start = 0; inq = False
    for i, c in enumerate(params):
        if inq:
            if c == 39: inq = False
            continue
        if c == 39: inq = True
        elif c == 40: depth += 1
        elif c == 41: depth -= 1
        elif c == 44 and depth == 0:
            out.append(params[start:i]); start = i + 1
    out.append(params[start:])
    return out

def reflist(b):
    b = b.strip()
    if not b.startswith(b'('): return []
    return [int(x) for x in re.findall(rb'#(\d+)', b)]

def single_ref(b):
    b = b.strip()
    m = re.match(rb'^#(\d+)$', b)
    return int(m.group(1)) if m else None

def shells(ents):
    """[(area, volume, nfaces)] for varje IFCCLOSEDSHELL"""
    pts = {}
    for sid, (typ, prm) in ents.items():
        if typ == 'IFCCARTESIANPOINT':
            nums = re.findall(rb'[-+0-9.eE]+', prm)
            v = [float(x) for x in nums]
            if len(v) >= 3: pts[sid] = (v[0], v[1], v[2])
    loops = {}
    for sid, (typ, prm) in ents.items():
        if typ == 'IFCPOLYLOOP': loops[sid] = reflist(top_items(prm)[0])
    bounds = {}
    for sid, (typ, prm) in ents.items():
        if typ in ('IFCFACEOUTERBOUND', 'IFCFACEBOUND'):
            it = top_items(prm)
            bounds[sid] = (single_ref(it[0]), it[1].strip() != b'.F.')
    faces = {}
    for sid, (typ, prm) in ents.items():
        if typ == 'IFCFACE': faces[sid] = reflist(top_items(prm)[0])
    out = []
    for sid, (typ, prm) in ents.items():
        if typ not in ('IFCCLOSEDSHELL', 'IFCOPENSHELL'): continue
        area = 0.0; vol = 0.0; nf = 0
        for f in reflist(top_items(prm)[0]):
            for b in faces.get(f, []):
                lp, orient = bounds.get(b, (None, True))
                poly = [pts[p] for p in loops.get(lp, []) if p in pts]
                if len(poly) < 3: continue
                if not orient: poly = poly[::-1]
                nx = ny = nz = 0.0
                for k in range(len(poly)):
                    a = poly[k]; c = poly[(k + 1) % len(poly)]
                    nx += (a[1] - c[1]) * (a[2] + c[2])
                    ny += (a[2] - c[2]) * (a[0] + c[0])
                    nz += (a[0] - c[0]) * (a[1] + c[1])
                area += 0.5 * math.sqrt(nx * nx + ny * ny + nz * nz)
                # volym via divergenssatsen, triangelfan fran forsta hornet
                o = poly[0]
                for k in range(1, len(poly) - 1):
                    p1 = poly[k]; p2 = poly[k + 1]
                    vol += (o[0] * (p1[1] * p2[2] - p1[2] * p2[1])
                            - o[1] * (p1[0] * p2[2] - p1[2] * p2[0])
                            + o[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6.0
            nf += 1
        out.append((round(area, 3), round(abs(vol), 3), nf))
    out.sort()
    return out

def guids(ents):
    g = {}
    for sid, (typ, prm) in ents.items():
        it = top_items(prm)
        if not it: continue
        first = it[0].strip()
        if len(first) == 24 and first.startswith(b"'") and first.endswith(b"'"):
            g[first[1:-1].decode('ascii', 'replace')] = typ
    return g


# forvantat antal attribut for vanliga typer (fangar fel parentesniva m.m.)
ATTRC = {'IFCCARTESIANPOINT': 1, 'IFCDIRECTION': 1, 'IFCPOLYLOOP': 1,
         'IFCFACEOUTERBOUND': 2, 'IFCFACEBOUND': 2, 'IFCFACE': 1,
         'IFCCLOSEDSHELL': 1, 'IFCOPENSHELL': 1, 'IFCFACETEDBREP': 1,
         'IFCAXIS2PLACEMENT2D': 2, 'IFCAXIS2PLACEMENT3D': 3,
         'IFCEXTRUDEDAREASOLID': 4, 'IFCRECTANGLEPROFILEDEF': 5,
         'IFCSHAPEREPRESENTATION': 4, 'IFCPRODUCTDEFINITIONSHAPE': 3,
         'IFCLOCALPLACEMENT': 2, 'IFCPOLYLINE': 1, 'IFCVECTOR': 2,
         'IFCPRESENTATIONLAYERASSIGNMENT': 4, 'IFCPROPERTYSET': 5,
         'IFCRELAGGREGATES': 6, 'IFCRELCONTAINEDINSPATIALSTRUCTURE': 6,
         'IFCRELDEFINESBYPROPERTIES': 6, 'IFCRELVOIDSELEMENT': 6,
         'IFCRELDEFINESBYTYPE': 6, 'IFCSTYLEDITEM': 3, 'IFCMAPPEDITEM': 2,
         'IFCREPRESENTATIONMAP': 2, 'IFCTRIANGULATEDFACESET': 5,
         'IFCUNITASSIGNMENT': 1, 'IFCSIUNIT': 4}
NUMLIST = re.compile(rb'^\(\s*[-+0-9.eE]+(\s*,\s*[-+0-9.eE]+)*\s*\)$')
REFLIST = re.compile(rb'^\(\s*#\d+(\s*,\s*#\d+)*\s*\)$')

def shape_check(ents):
    bad = collections.Counter()
    for sid, (typ, prm) in ents.items():
        it = top_items(prm)
        want = ATTRC.get(typ)
        if want is not None and len(it) != want:
            bad['%s: %d attribut (vantade %d)' % (typ, len(it), want)] += 1
            continue
        if typ in ('IFCCARTESIANPOINT', 'IFCDIRECTION'):
            if not NUMLIST.match(it[0].strip()):
                bad['%s: attribut 1 ar inte en tallista' % typ] += 1
        elif typ in ('IFCPOLYLOOP', 'IFCFACE', 'IFCCLOSEDSHELL', 'IFCOPENSHELL', 'IFCPOLYLINE'):
            if not REFLIST.match(it[0].strip()):
                bad['%s: attribut 1 ar inte en referenslista' % typ] += 1
        elif typ in ('IFCFACEOUTERBOUND', 'IFCFACEBOUND'):
            if single_ref(it[0]) is None or it[1].strip() not in (b'.T.', b'.F.'):
                bad['%s: felaktiga attribut' % typ] += 1
    return bad

def check(path):
    data, ents, order, dup = read(path)
    problems = []
    dangling = 0; danglingSample = []
    for sid, (typ, prm) in ents.items():
        for r in refs_of(prm):
            if r not in ents:
                dangling += 1
                if len(danglingSample) < 5: danglingSample.append('#%d(%s)->#%d' % (sid, typ, r))
    if dup: problems.append('%d dubblerade instansnummer' % dup)
    if dangling: problems.append('%d brutna referenser, t.ex. %s' % (dangling, ', '.join(danglingSample)))
    # tomma obligatoriska listor
    empt = 0
    for sid, (typ, prm) in ents.items():
        if typ.startswith('IFCREL') or typ in ('IFCFACE', 'IFCCLOSEDSHELL', 'IFCPOLYLOOP',
                                               'IFCSHAPEREPRESENTATION', 'IFCPRODUCTDEFINITIONSHAPE'):
            for it in top_items(prm):
                if it.strip() == b'()': empt += 1
    if empt: problems.append('%d tomma listor i obligatoriska attribut' % empt)
    if data.count(b'END-ISO-10303-21') != 1: problems.append('saknar korrekt filavslutning')
    for msg, cnt in shape_check(ents).most_common(8):
        problems.append('%s (%d st)' % (msg, cnt))
    types = collections.Counter(t for t, _ in ents.values())
    return {'path': path, 'bytes': len(data), 'instances': len(ents), 'problems': problems,
            'types': types, 'guids': guids(ents), 'shells': shells(ents)}

def show(r):
    print('--- %s' % os.path.basename(r['path']))
    print('    %s byte, %d instanser, %d typer, %d rotobjekt'
          % ('{:,}'.format(r['bytes']), r['instances'], len(r['types']), len(r['guids'])))
    if r['problems']:
        for p in r['problems']: print('    FEL: %s' % p)
    else:
        print('    OK: inga brutna referenser, inga dubbletter, giltig avslutning')

def refs_only(path):
    """minneslatt kontroll for stora filer: finns varje refererad instans?"""
    data = open(path, 'rb').read()
    i = data.find(b'DATA;')
    ids = set()
    for m in STMT.finditer(data, i):
        ids.add(int(m.group(1)))
    dangling = 0
    sample = []
    n = len(data)
    p = i
    inq = False
    while p < n:
        c = data[p]
        if inq:
            if c == 39:
                if p + 1 < n and data[p + 1] == 39: p += 2; continue
                inq = False
            p += 1; continue
        if c == 39: inq = True; p += 1; continue
        if c == 35:
            q = p + 1; v = 0; nd = 0
            while q < n and 48 <= data[q] <= 57:
                v = v * 10 + data[q] - 48; q += 1; nd += 1
            if nd:
                if v not in ids:
                    dangling += 1
                    if len(sample) < 5: sample.append('#%d' % v)
                p = q; continue
        p += 1
    print('--- %s' % os.path.basename(path))
    print('    %s byte, %d instanser' % ('{:,}'.format(len(data)), len(ids)))
    print('    brutna referenser: %d %s' % (dangling, ('t.ex. ' + ', '.join(sample)) if sample else ''))
    print('    filavslutning: %s' % ('OK' if data.count(b'END-ISO-10303-21') == 1 else 'SAKNAS'))
    return 0 if dangling == 0 else 2

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    flags = set(a for a in sys.argv[1:] if a.startswith('-'))
    if not args:
        print(__doc__); return 1
    if '--refs-only' in flags:
        rc = 0
        for a in args: rc |= refs_only(a)
        return rc
    a = check(args[0]); show(a)
    if len(args) == 1:
        for t, c in a['types'].most_common(12): print('      %-34s %6d' % (t, c))
        return 0 if not a['problems'] else 2
    b = check(args[1]); show(b)
    print('--- jamforelse')
    lost = [g for g in a['guids'] if g not in b['guids']]
    lostTypes = collections.Counter(a['guids'][g] for g in lost)
    print('    rotobjekt: %d -> %d  (%d borttagna)' % (len(a['guids']), len(b['guids']), len(lost)))
    for t, c in lostTypes.most_common(20): print('      bort: %-30s %d' % (t, c))
    gained = [g for g in b['guids'] if g not in a['guids']]
    if gained: print('    VARNING: %d rotobjekt finns bara i efterfilen' % len(gained))
    sa, sb = a['shells'], b['shells']
    print('    slutna skal: %d -> %d' % (len(sa), len(sb)))
    if len(sa) == len(sb):
        worst = 0.0; worstv = 0.0
        for (a1, v1, n1), (a2, v2, n2) in zip(sa, sb):
            if a1: worst = max(worst, abs(a1 - a2) / max(a1, 1e-9))
            if v1: worstv = max(worstv, abs(v1 - v2) / max(v1, 1e-9))
        print('    storsta relativa avvikelse  area %.3g   volym %.3g' % (worst, worstv))
        fa = sum(n for _, _, n in sa); fb = sum(n for _, _, n in sb)
        print('    ytor i skalen: %d -> %d' % (fa, fb))
        if worst > 1e-6 or worstv > 1e-6:
            print('    FEL: geometrin har andrats mer an avrundningen borde ge')
            return 2
        print('    OK: geometrin ar identisk (inom tolerans)')
    return 0 if not b['problems'] else 2

if __name__ == '__main__':
    sys.exit(main())
