/* ==========================================================================
   20-types.js  ·  IFC-kunskapen: kategorier, borttagningsregler, reparation
   --------------------------------------------------------------------------
   Allt är namnbaserat och schema-agnostiskt (IFC2X3 / IFC4 / IFC4X3), så
   nya klasser i nyare scheman hanteras av samma regler.
   ========================================================================== */

/* --- kategorier för storleksrapporten ------------------------------------ */
const CAT = {
  PT: 0, BREP: 1, SWEPT: 2, TESS: 3, PROP: 4, QTY: 5, TYPE: 6, MAT: 7,
  STYLE: 8, DRAW: 9, REL: 10, SPACE: 11, OPEN: 12, PLACE: 13, STRUCT: 14,
  PROD: 15, OTHER: 16
};
const CAT_LABEL = [
  'Punkter & riktningar', 'Ytor & skal (BREP)', 'Svepta solider', 'Tessellering (mesh)',
  'Egenskaper (Pset)', 'Mängder', 'Typobjekt', 'Material', 'Stilar & färger',
  '2D & annotation', 'Relationer', 'Rum & zoner', 'Öppningar', 'Placeringar',
  'Projektstruktur', 'Byggdelar', 'Övrigt'
];

function has(s, sub) { return s.indexOf(sub) >= 0; }

function categoryOf(t) {
  if (t === 'IFCCARTESIANPOINT' || t === 'IFCDIRECTION' || t === 'IFCVECTOR' ||
      t === 'IFCCARTESIANPOINTLIST2D' || t === 'IFCCARTESIANPOINTLIST3D') return CAT.PT;
  if (t === 'IFCPOLYLOOP' || t === 'IFCFACE' || t === 'IFCFACEOUTERBOUND' || t === 'IFCFACEBOUND' ||
      t === 'IFCCLOSEDSHELL' || t === 'IFCOPENSHELL' || t === 'IFCFACETEDBREP' ||
      t === 'IFCADVANCEDBREP' || t === 'IFCCONNECTEDFACESET' || t === 'IFCFACESURFACE' ||
      t === 'IFCSHELLBASEDSURFACEMODEL' || t === 'IFCFACEBASEDSURFACEMODEL' ||
      t === 'IFCEDGELOOP' || t === 'IFCORIENTEDEDGE' || t === 'IFCEDGECURVE' ||
      t === 'IFCVERTEXPOINT' || t === 'IFCADVANCEDFACE' || t === 'IFCVERTEXLOOP') return CAT.BREP;
  if (has(t, 'AREASOLID') || t === 'IFCBOOLEANRESULT' || t === 'IFCBOOLEANCLIPPINGRESULT' ||
      has(t, 'HALFSPACESOLID') || has(t, 'PROFILEDEF') || t === 'IFCSWEPTDISKSOLID' ||
      t === 'IFCCSGSOLID' || t === 'IFCBLOCK' || t === 'IFCRECTANGULARPYRAMID' ||
      t === 'IFCRIGHTCIRCULARCONE' || t === 'IFCRIGHTCIRCULARCYLINDER' ||
      t === 'IFCSPHERE' || t === 'IFCEXTRUDEDAREASOLIDTAPERED') return CAT.SWEPT;
  if (has(t, 'FACESET') || has(t, 'INDEXEDPOLY') || t === 'IFCINDEXEDPOLYGONALFACE' ||
      t === 'IFCINDEXEDPOLYGONALFACEWITHVOIDS' || has(t, 'TESSELLATED')) return CAT.TESS;
  if (t.startsWith('IFCPROPERTY') || t === 'IFCCOMPLEXPROPERTY' || t === 'IFCRELDEFINESBYPROPERTIES' ||
      t === 'IFCEXTENDEDPROPERTIES' || t.startsWith('IFCSIMPLEPROPERTY')) return CAT.PROP;
  if (t === 'IFCELEMENTQUANTITY' || t.startsWith('IFCQUANTITY') || t === 'IFCPHYSICALCOMPLEXQUANTITY') return CAT.QTY;
  if (t === 'IFCRELDEFINESBYTYPE') return CAT.REL;
  if (t.endsWith('TYPE') && !t.startsWith('IFCREL')) return CAT.TYPE;
  if (t === 'IFCDOORSTYLE' || t === 'IFCWINDOWSTYLE' || t === 'IFCDOORLININGPROPERTIES' ||
      t === 'IFCDOORPANELPROPERTIES' || t === 'IFCWINDOWLININGPROPERTIES' ||
      t === 'IFCWINDOWPANELPROPERTIES') return CAT.TYPE;
  if (t.startsWith('IFCMATERIAL')) return CAT.MAT;
  if (has(t, 'STYLE') || t.startsWith('IFCCOLOUR') || has(t, 'TEXTURE') ||
      t === 'IFCPRESENTATIONLAYERASSIGNMENT' || t === 'IFCPRESENTATIONLAYERWITHSTYLE' ||
      t === 'IFCDRAUGHTINGPREDEFINEDCOLOUR' || t === 'IFCDRAUGHTINGPREDEFINEDCURVEFONT' ||
      t === 'IFCINDEXEDCOLOURMAP') return CAT.STYLE;
  if (t === 'IFCANNOTATION' || t === 'IFCGEOMETRICCURVESET' || t === 'IFCGEOMETRICSET' ||
      has(t, 'TEXTLITERAL') || has(t, 'DIMENSIONCURVE') || t === 'IFCANNOTATIONFILLAREA' ||
      t.startsWith('IFCDRAUGHTING') || t === 'IFCTERMINATORSYMBOL' || t === 'IFCPROJECTIONCURVE') return CAT.DRAW;
  if (t === 'IFCSPACE' || t === 'IFCZONE' || t.startsWith('IFCRELSPACEBOUNDARY') ||
      t === 'IFCRELCOVERSSPACES' || t === 'IFCSPATIALZONE') return CAT.SPACE;
  if (t === 'IFCOPENINGELEMENT' || t === 'IFCOPENINGSTANDARDCASE' || t === 'IFCVOIDINGFEATURE' ||
      t === 'IFCRELVOIDSELEMENT' || t === 'IFCRELFILLSELEMENT') return CAT.OPEN;
  if (t === 'IFCLOCALPLACEMENT' || t === 'IFCAXIS2PLACEMENT2D' || t === 'IFCAXIS2PLACEMENT3D' ||
      t === 'IFCGRIDPLACEMENT' || t === 'IFCCARTESIANTRANSFORMATIONOPERATOR3D' ||
      t === 'IFCCARTESIANTRANSFORMATIONOPERATOR2D' ||
      t === 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM') return CAT.PLACE;
  if (t.startsWith('IFCREL')) return CAT.REL;
  if (t === 'IFCPROJECT' || t === 'IFCSITE' || t === 'IFCBUILDING' || t === 'IFCBUILDINGSTOREY' ||
      t === 'IFCUNITASSIGNMENT' || t.startsWith('IFCSIUNIT') || t.startsWith('IFCCONVERSIONBASED') ||
      t.startsWith('IFCDERIVEDUNIT') || t.startsWith('IFCMEASUREWITHUNIT') ||
      t === 'IFCOWNERHISTORY' || t === 'IFCPERSON' || t === 'IFCORGANIZATION' ||
      t === 'IFCPERSONANDORGANIZATION' || t === 'IFCAPPLICATION' ||
      t.startsWith('IFCGEOMETRICREPRESENTATIONCONTEXT') || t.startsWith('IFCGEOMETRICREPRESENTATIONSUB') ||
      t === 'IFCPROJECTEDCRS' || t === 'IFCMAPCONVERSION' || t === 'IFCDIMENSIONALEXPONENTS') return CAT.STRUCT;
  if (t === 'IFCPRODUCTDEFINITIONSHAPE' || t === 'IFCSHAPEREPRESENTATION' ||
      t === 'IFCREPRESENTATIONMAP' || t === 'IFCMAPPEDITEM' || t === 'IFCTOPOLOGYREPRESENTATION' ||
      t === 'IFCSHAPEASPECT') return CAT.PROD;
  return CAT.OTHER;
}

/* --- vilka typer räknas som "byggdel" (för klasslistan i analysen) ------- */
function isElementClass(t) {
  if (t.startsWith('IFCREL') || t.endsWith('TYPE')) return false;
  return ELEMENT_NAMES.has(t) || t === 'IFCBUILDINGELEMENTPROXY';
}
const ELEMENT_NAMES = new Set(('IFCWALL IFCWALLSTANDARDCASE IFCWALLELEMENTEDCASE IFCSLAB IFCSLABSTANDARDCASE ' +
  'IFCSLABELEMENTEDCASE IFCBEAM IFCBEAMSTANDARDCASE IFCCOLUMN IFCCOLUMNSTANDARDCASE IFCMEMBER ' +
  'IFCMEMBERSTANDARDCASE IFCPLATE IFCPLATESTANDARDCASE IFCDOOR IFCDOORSTANDARDCASE IFCWINDOW ' +
  'IFCWINDOWSTANDARDCASE IFCSTAIR IFCSTAIRFLIGHT IFCRAMP IFCRAMPFLIGHT IFCROOF IFCCOVERING ' +
  'IFCCURTAINWALL IFCRAILING IFCFOOTING IFCPILE IFCBUILDINGELEMENTPART IFCBUILDINGELEMENTPROXY ' +
  'IFCDISCRETEACCESSORY IFCMECHANICALFASTENER IFCFASTENER IFCREINFORCINGBAR IFCREINFORCINGMESH ' +
  'IFCREINFORCINGELEMENT IFCTENDON IFCTENDONANCHOR IFCFURNISHINGELEMENT IFCFURNITURE IFCSYSTEMFURNITUREELEMENT ' +
  'IFCFLOWSEGMENT IFCFLOWFITTING IFCFLOWTERMINAL IFCFLOWCONTROLLER IFCFLOWMOVINGDEVICE ' +
  'IFCFLOWSTORAGEDEVICE IFCFLOWTREATMENTDEVICE IFCENERGYCONVERSIONDEVICE IFCDISTRIBUTIONELEMENT ' +
  'IFCDISTRIBUTIONFLOWELEMENT IFCDISTRIBUTIONCONTROLELEMENT IFCDISTRIBUTIONCHAMBERELEMENT ' +
  'IFCDUCTSEGMENT IFCDUCTFITTING IFCPIPESEGMENT IFCPIPEFITTING IFCCABLECARRIERSEGMENT ' +
  'IFCCABLECARRIERFITTING IFCCABLESEGMENT IFCCABLEFITTING IFCJUNCTIONBOX IFCLIGHTFIXTURE ' +
  'IFCELECTRICAPPLIANCE IFCOUTLET IFCSWITCHINGDEVICE IFCSANITARYTERMINAL IFCAIRTERMINAL ' +
  'IFCAIRTERMINALBOX IFCFAN IFCPUMP IFCVALVE IFCBOILER IFCCHILLER IFCCOIL IFCCOMPRESSOR ' +
  'IFCCONDENSER IFCTANK IFCFILTER IFCDAMPER IFCSPACEHEATER IFCUNITARYEQUIPMENT ' +
  'IFCELEMENTASSEMBLY IFCTRANSPORTELEMENT IFCPROXY IFCVIRTUALELEMENT IFCELEMENTCOMPONENT ' +
  'IFCCIVILELEMENT IFCGEOGRAPHICELEMENT IFCCHIMNEY IFCSHADINGDEVICE IFCSTRUCTURALCURVEMEMBER ' +
  'IFCSTRUCTURALSURFACEMEMBER IFCBEARING IFCDEEPFOUNDATION IFCKERB IFCPAVEMENT IFCRAIL ' +
  'IFCCOURSE IFCEARTHWORKSFILL IFCEARTHWORKSCUT').split(' '));

/* --- rotobjekt (IfcRoot: GlobalId + OwnerHistory) ------------------------
   Vi upptäcker det strukturellt: attribut 1 är en 22 tecken lång sträng och
   attribut 2 är antingen $ eller en referens.                              */
function detectRoots(m, progress) {
  const roots = new Uint8Array(m.n);
  const buf = m.buf;
  const tmp = [];
  const step = Math.max(1, Math.floor(m.n / 20));

  /* $ eller en ren referens */
  const isNullOrRef = function (s, e) {
    const t = trimRange(buf, s, e); s = t[0]; e = t[1];
    if (e - s === 1 && buf[s] === CH_DOLLAR) return true;
    if (buf[s] !== CH_HASH || e - s < 2) return false;
    for (let k = s + 1; k < e; k++) if (!isDigit(buf[k])) return false;
    return true;
  };
  /* $ eller en citerad sträng */
  const isNullOrStr = function (s, e) {
    const t = trimRange(buf, s, e); s = t[0]; e = t[1];
    if (e - s === 1 && buf[s] === CH_DOLLAR) return true;
    return e - s >= 2 && buf[s] === CH_QUOTE && buf[e - 1] === CH_QUOTE;
  };

  for (let i = 0; i < m.n; i++) {
    if (progress && (i % step) === 0) progress(i / m.n);
    const e = m.pEnd(i);
    let p = m.pStart(i);
    if (e - p < 8) continue;
    while (p < e && isWs(buf[p])) p++;
    if (buf[p] !== CH_QUOTE) continue;      // GlobalId är alltid en sträng
    splitAttrs(buf, m.pStart(i), e, tmp);
    if (tmp.length < 8) continue;           // IfcRoot har minst 4 attribut
    const gl = quotedLen(buf, tmp[0], tmp[1]);
    if (gl < 8 || gl > 64) continue;
    if (!isNullOrRef(tmp[2], tmp[3])) continue;    // OwnerHistory
    if (!isNullOrStr(tmp[4], tmp[5])) continue;    // Name
    if (!isNullOrStr(tmp[6], tmp[7])) continue;    // Description
    roots[i] = 1;
  }
  return roots;
}

/* --- talpolicy: vilka typer får avrundas och med vilken skala ------------ */
const ROUND_COORD = new Set(('IFCCARTESIANPOINT IFCCARTESIANPOINTLIST2D IFCCARTESIANPOINTLIST3D ' +
  'IFCVECTOR IFCRECTANGLEPROFILEDEF IFCRECTANGLEHOLLOWPROFILEDEF IFCROUNDEDRECTANGLEPROFILEDEF ' +
  'IFCCIRCLEPROFILEDEF IFCCIRCLEHOLLOWPROFILEDEF IFCELLIPSEPROFILEDEF IFCISHAPEPROFILEDEF ' +
  'IFCASYMMETRICISHAPEPROFILEDEF IFCLSHAPEPROFILEDEF IFCTSHAPEPROFILEDEF IFCUSHAPEPROFILEDEF ' +
  'IFCZSHAPEPROFILEDEF IFCCSHAPEPROFILEDEF IFCEXTRUDEDAREASOLID IFCCIRCLE IFCELLIPSE ' +
  'IFCSPHERE IFCBLOCK IFCRIGHTCIRCULARCYLINDER IFCRIGHTCIRCULARCONE IFCRECTANGULARPYRAMID ' +
  'IFCSWEPTDISKSOLID IFCOFFSETCURVE2D IFCOFFSETCURVE3D IFCPLANARBOX IFCBOUNDINGBOX').split(' '));
const ROUND_RATIO = new Set(['IFCDIRECTION']);

/* --- reparationsåtgärder ------------------------------------------------- */
const ACT_RESURRECT = 0;   // okänd struktur: väck den döda referensen igen
const ACT_PRUNE_KILL = 1;  // rensa listor; tom lista / död enkelreferens => dör själv
const ACT_PRUNE_NULL = 2;  // rensa listor; tom lista / död enkelreferens => $
const ACT_KILL = 3;        // dör om någon referens är död

const ACT_TABLE = new Map();
(function () {
  const killList = ('IFCPRODUCTDEFINITIONSHAPE IFCSHAPEREPRESENTATION IFCSTYLEDREPRESENTATION ' +
    'IFCTOPOLOGYREPRESENTATION IFCPRESENTATIONLAYERASSIGNMENT IFCPRESENTATIONLAYERWITHSTYLE ' +
    'IFCFACE IFCFACESURFACE IFCADVANCEDFACE IFCCLOSEDSHELL IFCOPENSHELL IFCCONNECTEDFACESET ' +
    'IFCPOLYLOOP IFCEDGELOOP IFCPOLYLINE IFCCOMPOSITECURVE IFCCOMPOSITECURVE2D ' +
    'IFCSHELLBASEDSURFACEMODEL IFCFACEBASEDSURFACEMODEL IFCGEOMETRICCURVESET IFCGEOMETRICSET ' +
    'IFCSTYLEDITEM IFCPRESENTATIONSTYLEASSIGNMENT IFCINDEXEDPOLYGONALFACE ' +
    'IFCINDEXEDPOLYGONALFACEWITHVOIDS IFCPOLYGONALFACESET IFCTRIANGULATEDFACESET').split(' ');
  for (const t of killList) ACT_TABLE.set(t, ACT_PRUNE_KILL);
  const killIf = ('IFCMAPPEDITEM IFCREPRESENTATIONMAP IFCFACETEDBREP IFCFACEOUTERBOUND IFCFACEBOUND ' +
    'IFCMATERIALDEFINITIONREPRESENTATION IFCMATERIALLAYERSETUSAGE IFCMATERIALPROFILESETUSAGE ' +
    'IFCMATERIALLAYERSET IFCMATERIALPROFILESET IFCMATERIALCONSTITUENTSET IFCMATERIALLAYER ' +
    'IFCMATERIALPROFILE IFCMATERIALCONSTITUENT IFCMATERIALLIST').split(' ');
  for (const t of killIf) ACT_TABLE.set(t, ACT_KILL);
  ACT_TABLE.set('IFCPROJECT', ACT_RESURRECT);
})();

function actionFor(t, isRoot) {
  const a = ACT_TABLE.get(t);
  if (a !== undefined) return a;
  if (t.startsWith('IFCREL')) return ACT_PRUNE_KILL;
  if (isRoot) return ACT_PRUNE_NULL;
  return ACT_RESURRECT;
}

/* --- borttagningsgrupper -------------------------------------------------- */
function inDropSet(t, o) {
  if (o.dropPsets && (t.startsWith('IFCPROPERTY') || t === 'IFCCOMPLEXPROPERTY' ||
      t === 'IFCEXTENDEDPROPERTIES' || t === 'IFCRELDEFINESBYPROPERTIES')) {
    if (t === 'IFCPROPERTYSETTEMPLATE' || t === 'IFCPROPERTYTEMPLATE' ||
        t === 'IFCSIMPLEPROPERTYTEMPLATE') return true;
    return true;
  }
  if (o.dropQuantities && (t === 'IFCELEMENTQUANTITY' || t.startsWith('IFCQUANTITY') ||
      t === 'IFCPHYSICALCOMPLEXQUANTITY')) return true;
  if (o.dropTypes && (t === 'IFCRELDEFINESBYTYPE' || t === 'IFCDOORSTYLE' || t === 'IFCWINDOWSTYLE' ||
      t === 'IFCDOORLININGPROPERTIES' || t === 'IFCDOORPANELPROPERTIES' ||
      t === 'IFCWINDOWLININGPROPERTIES' || t === 'IFCWINDOWPANELPROPERTIES')) return true;
  if (o.dropMaterials && t.startsWith('IFCMATERIAL')) return true;
  if (o.dropMaterials && t === 'IFCRELASSOCIATESMATERIAL') return true;
  if (o.dropStyles) {
    if (t === 'IFCDOORSTYLE' || t === 'IFCWINDOWSTYLE') { /* typobjekt, inte stil */ }
    else if (has(t, 'STYLE') || t.startsWith('IFCCOLOUR') || has(t, 'TEXTURE') ||
             t === 'IFCDRAUGHTINGPREDEFINEDCOLOUR' || t === 'IFCDRAUGHTINGPREDEFINEDCURVEFONT' ||
             t === 'IFCINDEXEDCOLOURMAP' || t === 'IFCCURVEFONT' || t === 'IFCCURVEFONTPATTERN') return true;
  }
  if (o.dropLayers && (t === 'IFCPRESENTATIONLAYERASSIGNMENT' || t === 'IFCPRESENTATIONLAYERWITHSTYLE')) return true;
  if (o.dropClassifications && (t.startsWith('IFCCLASSIFICATION') || t.startsWith('IFCLIBRARY') ||
      t.startsWith('IFCDOCUMENT') || t === 'IFCRELASSOCIATESCLASSIFICATION' ||
      t === 'IFCRELASSOCIATESDOCUMENT' || t === 'IFCRELASSOCIATESLIBRARY' ||
      t === 'IFCEXTERNALREFERENCERELATIONSHIP')) return true;
  if (o.dropConnectivity && (t.startsWith('IFCRELCONNECTS') || t === 'IFCRELINTERFERESELEMENTS' ||
      t === 'IFCCONNECTIONPOINTECCENTRICITY' || t === 'IFCCONNECTIONSURFACEGEOMETRY' ||
      t === 'IFCCONNECTIONCURVEGEOMETRY' || t === 'IFCCONNECTIONPOINTGEOMETRY')) return true;
  if (o.drop2D && (t === 'IFCANNOTATION' || t === 'IFCGEOMETRICCURVESET' ||
      has(t, 'TEXTLITERAL') || has(t, 'DIMENSIONCURVE') || t === 'IFCANNOTATIONFILLAREA' ||
      t === 'IFCANNOTATIONFILLAREAOCCURRENCE' || t.startsWith('IFCDRAUGHTINGCALLOUT') ||
      t === 'IFCTERMINATORSYMBOL' || t === 'IFCPROJECTIONCURVE' || t === 'IFCANNOTATIONCURVEOCCURRENCE' ||
      t === 'IFCANNOTATIONSURFACE' || t === 'IFCANNOTATIONTEXTOCCURRENCE')) return true;
  if (o.dropGrids && (t === 'IFCGRID' || t === 'IFCGRIDAXIS' || t === 'IFCVIRTUALGRIDINTERSECTION')) return true;
  if (o.dropSpaces && (t === 'IFCSPACE' || t === 'IFCSPACETYPE' || t === 'IFCZONE' ||
      t.startsWith('IFCRELSPACEBOUNDARY') || t === 'IFCRELCOVERSSPACES' || t === 'IFCSPATIALZONE')) return true;
  if (o.dropSpaceBoundaries && (t.startsWith('IFCRELSPACEBOUNDARY') || t === 'IFCRELCOVERSSPACES')) return true;
  if (o.dropOpenings && (t === 'IFCOPENINGELEMENT' || t === 'IFCOPENINGSTANDARDCASE' ||
      t === 'IFCVOIDINGFEATURE' || t === 'IFCRELVOIDSELEMENT' || t === 'IFCRELFILLSELEMENT')) return true;
  return false;
}

/* Representationsidentifierare som räknas som 2D/hjälpgeometri.            */
const DROP_REP_IDENT = new Set(['AXIS', 'FOOTPRINT', 'BOX', 'PROFILE', 'ANNOTATION', 'CLEARANCE',
  'LIGHTING', 'COG', 'SURVEYPOINTS', 'AXIS2D', 'AXIS3D']);
const DROP_REP_TYPE = new Set(['CURVE2D', 'ANNOTATION2D', 'GEOMETRICCURVESET']);
