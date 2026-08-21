#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Geometrikontroll for stora BREP-modeller: total yta och volym.

  python tools/area_check.py fore.ifc efter.ifc

Bade koplanar sammanslagning och dubblettsammanslagning ska lamna total
mantelyta och total volym oforandrade (bortsett fran avrundningen). Skriptet
laser bara geometri - inga namn, GUID:n eller egenskaper.
"""
import io, os, re, sys, math

PT = re.compile(rb'#(\d+)=\s*IFCCARTESIANPOINT\(\(([^)]*)\)\)')
LOOP = re.compile(rb'#(\d+)=\s*IFCPOLYLOOP\(\(([^)]*)\)\)')
BND = re.compile(rb'#(\d+)=\s*IFCFACE(?:OUTER)?BOUND\(#(\d+),\.([TF])\.\)')
FACE = re.compile(rb'#(\d+)=\s*IFCFACE\(\(([^)]*)\)\)')
SHELL = re.compile(rb'#(\d+)=\s*IFC(?:CLOSED|OPEN)SHELL\(\(([^)]*)\)\)')
NUM = re.compile(rb'[-+0-9.eE]+')

def scan(path):
    data = open(path, 'rb').read()
    pts = {}
    for m in PT.finditer(data):
        v = [float(x) for x in NUM.findall(m.group(2))]
        if len(v) >= 3:
            pts[int(m.group(1))] = (v[0], v[1], v[2])
    loops = {}
    for m in LOOP.finditer(data):
        loops[int(m.group(1))] = [int(x) for x in re.findall(rb'#(\d+)', m.group(2))]
    bnds = {}
    for m in BND.finditer(data):
        bnds[int(m.group(1))] = (int(m.group(2)), m.group(3) == b'T')
    faces = {}
    for m in FACE.finditer(data):
        faces[int(m.group(1))] = [int(x) for x in re.findall(rb'#(\d+)', m.group(2))]
    shells = {}
    for m in SHELL.finditer(data):
        shells[int(m.group(1))] = [int(x) for x in re.findall(rb'#(\d+)', m.group(2))]
    del data
    return pts, loops, bnds, faces, shells

def loop_vec(pts, ids):
    nx = ny = nz = 0.0
    L = len(ids)
    if L < 3:
        return None
    for i in range(L):
        a = pts.get(ids[i]); b = pts.get(ids[(i + 1) % L])
        if a is None or b is None:
            return None
        nx += (a[1] - b[1]) * (a[2] + b[2])
        ny += (a[2] - b[2]) * (a[0] + b[0])
        nz += (a[0] - b[0]) * (a[1] + b[1])
    return (nx / 2.0, ny / 2.0, nz / 2.0)

def face_stats(pts, loops, bnds, faces, fid):
    """(netto-area, volymbidrag) for en yta med hansyn till innerslingor"""
    bl = faces.get(fid) or []
    vecs = []
    for b in bl:
        lp = bnds.get(b)
        if lp is None:
            return None
        ids = loops.get(lp[0])
        if not ids:
            return None
        if not lp[1]:
            ids = ids[::-1]
        v = loop_vec(pts, ids)
        if v is None:
            return None
        vecs.append((v, ids))
    if not vecs:
        return None
    v0 = vecs[0][0]
    n0 = math.sqrt(v0[0] ** 2 + v0[1] ** 2 + v0[2] ** 2)
    if n0 == 0:
        return (0.0, 0.0)
    u = (v0[0] / n0, v0[1] / n0, v0[2] / n0)
    area = 0.0
    vol = 0.0
    for v, ids in vecs:
        area += v[0] * u[0] + v[1] * u[1] + v[2] * u[2]
        o = pts[ids[0]]
        for k in range(1, len(ids) - 1):
            p1 = pts[ids[k]]; p2 = pts[ids[k + 1]]
            vol += (o[0] * (p1[1] * p2[2] - p1[2] * p2[1])
                    - o[1] * (p1[0] * p2[2] - p1[2] * p2[0])
                    + o[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6.0
    return (area, vol)

def totals(path):
    pts, loops, bnds, faces, shells = scan(path)
    area = 0.0
    vol = 0.0
    nf = 0
    bad = 0
    per = []
    for sid, fl in shells.items():
        sa = 0.0
        sv = 0.0
        for fid in fl:
            r = face_stats(pts, loops, bnds, faces, fid)
            if r is None:
                bad += 1
                continue
            sa += r[0]
            sv += r[1]
            nf += 1
        area += sa
        vol += sv
        per.append((sa, sv, len(fl)))
    per.sort()
    return {'path': path, 'shells': len(shells), 'faces': nf, 'bad': bad,
            'area': area, 'vol': vol, 'points': len(pts), 'loops': len(loops), 'per': per}

def match_shells(a, b, tol=2e-3):
    """Varje skal i b maste ha en formmassig motsvarighet i a. Toleransen ar
    relativ och maste rymma koordinatavrundningen - sma detaljer paverkas
    procentuellt mer av en absolut avrundning an stora byggdelar."""
    import collections
    def key(s):
        return (round(s[0], 3), round(abs(s[1]), 3))
    pool = collections.Counter(key(s) for s in a['per'])
    unmatched = []
    worst = 0.0
    for s in b['per']:
        k = key(s)
        if pool[k] > 0:
            pool[k] -= 1
            continue
        hit = None
        hitd = None
        for kk, cnt in pool.items():
            if cnt <= 0:
                continue
            da = abs(kk[0] - k[0]) / max(abs(k[0]), 1.0)
            dv = abs(kk[1] - k[1]) / max(abs(k[1]), 1.0)
            d = max(da, dv)
            if d < tol and (hitd is None or d < hitd):
                hit = kk
                hitd = d
        if hit is not None:
            pool[hit] -= 1
            if hitd > worst:
                worst = hitd
        else:
            unmatched.append(s)
    leftover = sum(c for c in pool.values() if c > 0)
    return unmatched, leftover, worst

def main():
    if len(sys.argv) < 2:
        print(__doc__); return 1
    rs = [totals(p) for p in sys.argv[1:]]
    for r in rs:
        print('--- %s' % os.path.basename(r['path']))
        print('    skal %d, ytor %d (%d olasbara), punkter %d, slingor %d'
              % (r['shells'], r['faces'], r['bad'], r['points'], r['loops']))
        print('    total mantelyta %.6g   total volym %.6g' % (r['area'], r['vol']))
    if len(rs) == 2:
        unmatched, leftover, worst = match_shells(rs[0], rs[1])
        print('--- skal-for-skal')
        print('    skal i efterfilen utan motsvarighet i forefilen: %d' % len(unmatched))
        print('    skal i forefilen som inte aterfinns (dubbletter som slagits ihop): %d' % leftover)
        print('    storsta formavvikelse bland matchade skal: %.3g' % worst)
        for s in unmatched[:5]:
            print('      avvikande skal: area %.6g volym %.6g ytor %d' % s)
        ok = len(unmatched) == 0
        print('    %s' % ('OK: varje kvarvarande skal har exakt samma form som fore'
                          if ok else 'FEL: nagot skal har andrat form'))
        return 0 if ok else 2
    return 0

if __name__ == '__main__':
    sys.exit(main())
