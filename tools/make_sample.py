#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Genererar syntetiska IFC-filer for att testa IFC Optimizer.

Ingen kunddata - allt ar paphittat. Filerna tacker medvetet alla
funktioner i optimeraren: dubbletter, langa flyttal, forladralosa objekt,
psets, mangder, typer, material, stilar, lager, 2D-representationer, rum
med innehall, oppningar, rutnat, BREP-lador (koplanara trianglar) och
IFC4-tessellering.
"""
import io, os, sys, re

GUIDRE = re.compile(r"'((?:0Test|4Test)[^']*)'")

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'test')

class Spf:
    def __init__(self, schema='IFC2X3'):
        self.rows = []
        self.n = 0
        self.schema = schema
    def add(self, body):
        body = GUIDRE.sub(lambda m: "'" + (m.group(1) + '0' * 22)[:22] + "'", body)
        self.n += 1
        self.rows.append('#%d= %s;' % (self.n, body))
        return '#%d' % self.n
    def text(self, name):
        head = ("ISO-10303-21;\nHEADER;\n"
                "FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');\n"
                "FILE_NAME('%s','2026-08-21T09:00:00',(''),(''),'Testgenerator','BIM Engine sample','');\n"
                "FILE_SCHEMA(('%s'));\nENDSEC;\n\nDATA;\n" % (name, self.schema))
        tail = "ENDSEC;\nEND-ISO-10303-21;\n"
        return head + '\n'.join(self.rows) + '\n' + tail

def pt(f, x, y, z=None, noisy=True):
    """Cartesian point. noisy => manga decimaler som avrundningen ska stada."""
    def v(a):
        if noisy and a != 0:
            return repr(a + 0.000000000123456789)
        return ('%.1f' % a) if a == int(a) else repr(a)
    if z is None:
        return f.add('IFCCARTESIANPOINT((%s,%s))' % (v(x), v(y)))
    return f.add('IFCCARTESIANPOINT((%s,%s,%s))' % (v(x), v(y), v(z)))

def box_brep(f, x0, y0, z0, dx, dy, dz):
    """Kub som 12 trianglar -> koplanar sammanslagning ska ge 6 ytor."""
    c = [(x0, y0, z0), (x0+dx, y0, z0), (x0+dx, y0+dy, z0), (x0, y0+dy, z0),
         (x0, y0, z0+dz), (x0+dx, y0, z0+dz), (x0+dx, y0+dy, z0+dz), (x0, y0+dy, z0+dz)]
    ids = [pt(f, p[0], p[1], p[2]) for p in c]
    quads = [(0,3,2,1), (4,5,6,7), (0,1,5,4), (1,2,6,5), (2,3,7,6), (3,0,4,7)]
    faces = []
    for q in quads:
        for tri in ((q[0], q[1], q[2]), (q[0], q[2], q[3])):
            loop = f.add('IFCPOLYLOOP((%s))' % ','.join(ids[i] for i in tri))
            bnd = f.add('IFCFACEOUTERBOUND(%s,.T.)' % loop)
            faces.append(f.add('IFCFACE((%s))' % bnd))
    shell = f.add('IFCCLOSEDSHELL((%s))' % ','.join(faces))
    return f.add('IFCFACETEDBREP(%s)' % shell)

def build_ifc2x3():
    f = Spf('IFC2X3')
    person = f.add("IFCPERSON($,'Testsson','Test',$,$,$,$,$)")
    org = f.add("IFCORGANIZATION($,'BIM Engine',$,$,$)")
    po = f.add('IFCPERSONANDORGANIZATION(%s,%s,$)' % (person, org))
    app = f.add("IFCAPPLICATION(%s,'1.0','Testgenerator','TG')" % org)
    oh = f.add('IFCOWNERHISTORY(%s,%s,$,.ADDED.,$,$,$,0)' % (po, app))
    oh2 = f.add('IFCOWNERHISTORY(%s,%s,$,.ADDED.,$,$,$,0)' % (po, app))  # dubblett

    p0 = pt(f, 0, 0, 0, noisy=False)
    dz = f.add('IFCDIRECTION((0.,0.,1.))')
    dx = f.add('IFCDIRECTION((1.,0.,0.))')
    dxd = f.add('IFCDIRECTION((1.,0.,0.))')            # dubblett
    ax = f.add('IFCAXIS2PLACEMENT3D(%s,%s,%s)' % (p0, dz, dx))
    ctx = f.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,%s,$)" % ax)
    sub_body = f.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,%s,$,.MODEL_VIEW.,$)" % ctx)
    sub_axis = f.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,%s,$,.GRAPH_VIEW.,$)" % ctx)

    mm = f.add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')
    rad = f.add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')
    units = f.add('IFCUNITASSIGNMENT((%s,%s))' % (mm, rad))

    proj = f.add("IFCPROJECT('0Testprojekt0000000001',%s,'Testprojekt',$,$,$,$,(%s),%s)" % (oh, ctx, units))
    lp_site = f.add('IFCLOCALPLACEMENT($,%s)' % ax)
    site = f.add("IFCSITE('0Testsite000000000001',%s,'Site',$,$,%s,$,$,.ELEMENT.,$,$,$,$,$)" % (oh, lp_site))
    bldg = f.add("IFCBUILDING('0Testbyggnad000000001',%s,'Byggnad',$,$,%s,$,$,.ELEMENT.,$,$,$)" % (oh, lp_site))
    storey = f.add("IFCBUILDINGSTOREY('0Testvaning000000001',%s,'Plan 1',$,$,%s,$,$,.ELEMENT.,0.)" % (oh, lp_site))

    # --- tva vaggar med BREP-kropp och 2D-axel ---
    walls = []
    for k in range(2):
        ohk = oh if k == 0 else oh2
        brep = box_brep(f, k * 5000, 0, 0, 4000, 200, 3000)
        body = f.add("IFCSHAPEREPRESENTATION(%s,'Body','Brep',(%s))" % (sub_body, brep))
        a1 = pt(f, k * 5000, 100, noisy=False)
        a2 = pt(f, k * 5000 + 4000, 100, noisy=False)
        poly = f.add('IFCPOLYLINE((%s,%s))' % (a1, a2))
        axisrep = f.add("IFCSHAPEREPRESENTATION(%s,'Axis','Curve2D',(%s))" % (sub_axis, poly))
        pds = f.add('IFCPRODUCTDEFINITIONSHAPE($,$,(%s,%s))' % (body, axisrep))
        lp = f.add('IFCLOCALPLACEMENT(%s,%s)' % (lp_site, ax))
        w = f.add("IFCWALLSTANDARDCASE('0Testvagg%011d',%s,'Vagg %d',$,$,%s,%s,$)" % (k, oh, k + 1, lp, pds))
        walls.append(w)
        # stil pa kroppen
        col = f.add('IFCCOLOURRGB($,0.8,0.8,0.75)')
        sr = f.add('IFCSURFACESTYLERENDERING(%s,$,$,$,$,$,$,$,.NOTDEFINED.)' % col)
        ss = f.add("IFCSURFACESTYLE('Betong',.BOTH.,(%s))" % sr)
        psa = f.add('IFCPRESENTATIONSTYLEASSIGNMENT((%s))' % ss)
        f.add('IFCSTYLEDITEM(%s,(%s),$)' % (brep, psa))
        # egenskaper
        p1 = f.add("IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('VAGG-200'),$)")
        p2 = f.add("IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$)")
        pset = f.add("IFCPROPERTYSET('0Testpset%011d',%s,'Pset_WallCommon',$,(%s,%s))" % (k, ohk, p1, p2))
        f.add("IFCRELDEFINESBYPROPERTIES('0Testrelpset%08d',%s,$,$,(%s),%s)" % (k, oh, w, pset))
        q1 = f.add("IFCQUANTITYAREA('NetSideArea',$,$,12.)")
        eq = f.add("IFCELEMENTQUANTITY('0Testqty%012d',%s,'BaseQuantities',$,$,(%s))" % (k, oh, q1))
        f.add("IFCRELDEFINESBYPROPERTIES('0Testrelqty%09d',%s,$,$,(%s),%s)" % (k, oh, w, eq))

    # --- vaggtyp ---
    wtype = f.add("IFCWALLTYPE('0Testvaggtyp00000001',%s,'Vaggtyp 200',$,$,$,$,$,$,.STANDARD.)" % oh)
    f.add("IFCRELDEFINESBYTYPE('0Testreltype00000001',%s,$,$,(%s),%s)" % (oh, ','.join(walls), wtype))

    # --- material ---
    mat = f.add("IFCMATERIAL('Betong C30/37')")
    ml = f.add('IFCMATERIALLAYER(%s,200.,$)' % mat)
    mls = f.add("IFCMATERIALLAYERSET((%s),'Vagg 200')" % ml)
    mlsu = f.add('IFCMATERIALLAYERSETUSAGE(%s,.AXIS2.,.POSITIVE.,0.)' % mls)
    f.add("IFCRELASSOCIATESMATERIAL('0Testrelmat000000001',%s,$,$,(%s),%s)" % (oh, ','.join(walls), mlsu))

    # --- oppning i vagg 1 ---
    obrep = box_brep(f, 1000, 0, 900, 1000, 200, 1200)
    obody = f.add("IFCSHAPEREPRESENTATION(%s,'Body','Brep',(%s))" % (sub_body, obrep))
    opds = f.add('IFCPRODUCTDEFINITIONSHAPE($,$,(%s))' % obody)
    olp = f.add('IFCLOCALPLACEMENT(%s,%s)' % (lp_site, ax))
    opening = f.add("IFCOPENINGELEMENT('0Testoppning00000001',%s,'Oppning',$,$,%s,%s,$)" % (oh, olp, opds))
    f.add("IFCRELVOIDSELEMENT('0Testrelvoid00000001',%s,$,$,%s,%s)" % (oh, walls[0], opening))

    # --- rum som innehaller vagg 2 ---
    sbrep = box_brep(f, 0, 500, 0, 4000, 4000, 3000)
    sbody = f.add("IFCSHAPEREPRESENTATION(%s,'Body','Brep',(%s))" % (sub_body, sbrep))
    spds = f.add('IFCPRODUCTDEFINITIONSHAPE($,$,(%s))' % sbody)
    slp = f.add('IFCLOCALPLACEMENT(%s,%s)' % (lp_site, ax))
    space = f.add("IFCSPACE('0Testrum000000000001',%s,'Rum 001',$,$,%s,%s,$,.ELEMENT.,.INTERNAL.,0.)" % (oh, slp, spds))

    # --- rutnat ---
    g1 = pt(f, 0, 0, noisy=False)
    g2 = pt(f, 10000, 0, noisy=False)
    gl = f.add('IFCPOLYLINE((%s,%s))' % (g1, g2))
    gax = f.add("IFCGRIDAXIS('A',%s,.T.)" % gl)
    glp = f.add('IFCLOCALPLACEMENT(%s,%s)' % (lp_site, ax))
    grid = f.add("IFCGRID('0Testrutnat000000001',%s,'Rutnat',$,$,%s,$,(%s),$,$)" % (oh, glp, gax))

    # --- annotation (2D) ---
    tp = pt(f, 500, 500, noisy=False)
    tax = f.add('IFCAXIS2PLACEMENT2D(%s,$)' % tp)
    tl = f.add("IFCTEXTLITERAL('Text',%s,.RIGHT.)" % tax)
    gcs = f.add('IFCGEOMETRICCURVESET((%s))' % tl)
    arep = f.add("IFCSHAPEREPRESENTATION(%s,'Annotation','Annotation2D',(%s))" % (sub_axis, gcs))
    apds = f.add('IFCPRODUCTDEFINITIONSHAPE($,$,(%s))' % arep)
    anno = f.add("IFCANNOTATION('0Testanno00000000001',%s,'Not',$,$,%s,%s)" % (oh, glp, apds))

    # --- presentationslager ---
    f.add("IFCPRESENTATIONLAYERASSIGNMENT('A-VAGG',$,(%s),$)" % ','.join(walls))

    # --- rumsstruktur ---
    f.add("IFCRELAGGREGATES('0Testrelagg000000001',%s,$,$,%s,(%s))" % (oh, proj, site))
    f.add("IFCRELAGGREGATES('0Testrelagg000000002',%s,$,$,%s,(%s))" % (oh, site, bldg))
    f.add("IFCRELAGGREGATES('0Testrelagg000000003',%s,$,$,%s,(%s))" % (oh, bldg, storey))
    f.add("IFCRELAGGREGATES('0Testrelagg000000004',%s,$,$,%s,(%s))" % (oh, storey, space))
    f.add("IFCRELCONTAINEDINSPATIALSTRUCTURE('0Testrelcont00000001',%s,$,$,(%s,%s,%s),%s)"
          % (oh, walls[0], grid, anno, storey))
    f.add("IFCRELCONTAINEDINSPATIALSTRUCTURE('0Testrelcont00000002',%s,$,$,(%s),%s)"
          % (oh, walls[1], space))

    # --- forladralost skrap som skrapsamlingen ska ta ---
    orphan_pt = pt(f, 999, 999, 999)
    f.add('IFCPOLYLINE((%s,%s))' % (orphan_pt, orphan_pt))
    f.add("IFCRECTANGLEPROFILEDEF(.AREA.,'Oanvand',$,100.,200.)")
    return f, {'walls': 2, 'oh_dupes': 1}

def build_ifc4_tess():
    f = Spf('IFC4')
    org = f.add("IFCORGANIZATION($,'BIM Engine',$,$,$)")
    app = f.add("IFCAPPLICATION(%s,'1.0','Testgenerator','TG')" % org)
    p0 = f.add('IFCCARTESIANPOINT((0.,0.,0.))')
    dz = f.add('IFCDIRECTION((0.,0.,1.))')
    dx = f.add('IFCDIRECTION((1.,0.,0.))')
    ax = f.add('IFCAXIS2PLACEMENT3D(%s,%s,%s)' % (p0, dz, dx))
    ctx = f.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,%s,$)" % ax)
    sub = f.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,%s,$,.MODEL_VIEW.,$)" % ctx)
    mm = f.add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')
    units = f.add('IFCUNITASSIGNMENT((%s))' % mm)
    proj = f.add("IFCPROJECT('4Testprojekt0000000001',$,'Tess',$,$,$,$,(%s),%s)" % (ctx, units))
    # kub som triangelmesh, med dubblerade horn som svetsningen ska sla ihop
    verts = [(0,0,0),(1000,0,0),(1000,1000,0),(0,1000,0),
             (0,0,1000),(1000,0,1000),(1000,1000,1000),(0,1000,1000),
             (0.0000004,0,0)]          # nastan samma som vertex 1
    rows = ','.join('(%s)' % ','.join(repr(float(c) + 0.000000000987654321) for c in v) for v in verts)
    pl = f.add('IFCCARTESIANPOINTLIST3D((%s))' % rows)
    tris = [(1,4,3),(1,3,2),(5,6,7),(5,7,8),(1,2,6),(1,6,5),
            (2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8),(9,9,9)]
    tris = [t for t in tris if len(set(t)) == 3]
    idx = ','.join('(%d,%d,%d)' % t for t in tris)
    fs = f.add('IFCTRIANGULATEDFACESET(%s,$,.T.,(%s),$)' % (pl, idx))
    rep = f.add("IFCSHAPEREPRESENTATION(%s,'Body','Tessellation',(%s))" % (sub, fs))
    pds = f.add('IFCPRODUCTDEFINITIONSHAPE($,$,(%s))' % rep)
    lp = f.add('IFCLOCALPLACEMENT($,%s)' % ax)
    site = f.add("IFCSITE('4Testsite000000000001',$,'Site',$,$,%s,$,$,.ELEMENT.,$,$,$,$,$)" % lp)
    prox = f.add("IFCBUILDINGELEMENTPROXY('4Testproxy0000000001',$,'Kub',$,$,%s,%s,$,$)" % (lp, pds))
    f.add("IFCRELAGGREGATES('4Testrelagg000000001',$,$,$,%s,(%s))" % (proj, site))
    f.add("IFCRELCONTAINEDINSPATIALSTRUCTURE('4Testrelcont00000001',$,$,$,(%s),%s)" % (prox, site))
    return f, {}

def main():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    f, _ = build_ifc2x3()
    n1 = 'sample_2x3.ifc'
    io.open(os.path.join(OUT, n1), 'w', encoding='ascii', newline='\r\n').write(f.text(n1))
    f2, _ = build_ifc4_tess()
    n2 = 'sample_ifc4_tess.ifc'
    io.open(os.path.join(OUT, n2), 'w', encoding='ascii', newline='\r\n').write(f2.text(n2))
    for n in (n1, n2):
        p = os.path.join(OUT, n)
        print('%-24s %8d B' % (n, os.path.getsize(p)))

if __name__ == '__main__':
    main()
