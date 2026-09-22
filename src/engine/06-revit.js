/* ==========================================================================
   06-revit.js  ·  kunskap om Revits IFC-exportinställningar
   --------------------------------------------------------------------------
   Laddas både i gränssnittet och i motorn. Etiketterna är på engelska
   eftersom exporten körs i engelsk Revit (ENU).
   ========================================================================== */

/* --- Revits exportinställningar: nyckel -> etikett, flik, betydelse ------- */
const REVIT_SETTINGS = {
  IFCVersion:                    { label: 'IFC version', tab: 'General', kind: 'val' },
  IFCFileType:                   { label: 'File type', tab: 'General', kind: 'val' },
  SpaceBoundaries:               { label: 'Space boundaries', tab: 'General', kind: 'val' },
  SplitWallsAndColumns:          { label: 'Split walls, columns, ducts by level', tab: 'General', kind: 'bool' },
  IncludeSteelElements:          { label: 'Include steel elements', tab: 'General', kind: 'bool' },
  VisibleElementsOfCurrentView:  { label: 'Export only elements visible in view', tab: 'General', kind: 'bool' },
  Export2DElements:              { label: 'Export 2D plan view elements', tab: 'Additional Content', kind: 'bool' },
  ExportLinkedFiles:             { label: 'Export linked files as separate IFCs', tab: 'Additional Content', kind: 'bool' },
  ExportRoomsInView:             { label: 'Export rooms, areas and spaces in 3D views', tab: 'Additional Content', kind: 'bool' },
  ExportInternalRevitPropertySets:{ label: 'Export Revit property sets', tab: 'Property Sets', kind: 'bool' },
  ExportIFCCommonPropertySets:   { label: 'Export IFC common property sets', tab: 'Property Sets', kind: 'bool' },
  ExportBaseQuantities:          { label: 'Export base quantities', tab: 'Property Sets', kind: 'bool' },
  ExportSchedulesAsPsets:        { label: 'Export schedules as property sets', tab: 'Property Sets', kind: 'bool' },
  ExportSpecificSchedules:       { label: 'Export only schedules containing IFC, Pset or Common in the title', tab: 'Property Sets', kind: 'bool' },
  ExportUserDefinedPsets:        { label: 'Export user defined property sets', tab: 'Property Sets', kind: 'bool' },
  ExportUserDefinedParameterMapping: { label: 'Export parameter mapping table', tab: 'Property Sets', kind: 'bool' },
  ExportMaterialPsets:           { label: 'Export material property sets', tab: 'Property Sets', kind: 'bool' },
  TessellationLevelOfDetail:     { label: 'Level of detail for some element geometry', tab: 'Level of Detail', kind: 'val' },
  ExportPartsAsBuildingElements: { label: 'Export parts as building elements', tab: 'Advanced', kind: 'bool' },
  ExportSolidModelRep:           { label: "Allow use of mixed 'Solid Model' representation", tab: 'Advanced', kind: 'bool' },
  UseActiveViewGeometry:         { label: 'Use active view when creating geometry', tab: 'Advanced', kind: 'bool' },
  ExportBoundingBox:             { label: 'Export bounding box', tab: 'Advanced', kind: 'bool' },
  UseOnlyTriangulation:          { label: 'Keep tessellated geometry as triangulation', tab: 'Advanced', kind: 'bool' },
  Use2DRoomBoundaryForVolume:    { label: 'Use 2D room boundaries for room volume', tab: 'Advanced', kind: 'bool' },
  IncludeSiteElevation:          { label: 'Include IFCSITE elevation in the site local placement origin', tab: 'Advanced', kind: 'bool' },
  StoreIFCGUID:                  { label: 'Store the IFC GUID in an element parameter after export', tab: 'Advanced', kind: 'bool' },
  UseFamilyAndTypeNameForReference: { label: 'Use family and type name for reference', tab: 'Advanced', kind: 'bool' },
  UseTypeNameOnlyForIfcType:     { label: 'Use Type name only for IfcType name', tab: 'Advanced', kind: 'bool' },
  UseVisibleRevitNameAsEntityName: { label: 'Use visible Revit name as IfcEntity name', tab: 'Advanced', kind: 'bool' },
  ExcludeFilter:                 { label: 'Entities to export (uteslutna klasser)', tab: 'General', kind: 'val' }
};

const FILE_TYPES = { 0: 'IFC (okomprimerad)', 1: 'ifcXML', 2: 'Zippad IFC (.ifczip)', 3: 'Zippad ifcXML' };
const SPACE_BOUNDARY_LEVELS = { 0: 'None', 1: '1st level', 2: '2nd level' };

/* Revits egna parametergrupper dyker upp som Pset-namn när
   "Export Revit property sets" är påslaget. */
const REVIT_GROUP_PSETS = new Set(['Constraints', 'Dimensions', 'Identity Data', 'Phasing', 'Other',
  'Graphics', 'Materials and Finishes', 'Construction', 'Text', 'Data', 'Structural',
  'Analytical Model', 'Analytical Properties', 'Electrical', 'Electrical - Loads',
  'Mechanical', 'Mechanical - Flow', 'Plumbing', 'Energy Analysis', 'IFC Parameters',
  'Model Properties', 'Rebar Set', 'Visibility', 'Layers', 'Title Text', 'General']);

function isRevitPset(name) {
  const n = String(name || '');
  return /^p?set_revit/i.test(n) || REVIT_GROUP_PSETS.has(n);
}
function isCommonPset(name) {
  return /^Pset_.*Common$/i.test(String(name || '')) || /^Pset_/i.test(String(name || ''));
}

/* --- inläsning av en exporterad inställningsfil --------------------------- */
function parseExportConfig(text) {
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    throw new Error('Kunde inte tolka inställningsfilen som JSON: ' + e.message);
  }
  if (Array.isArray(raw)) raw = raw[0] || {};
  if (!raw || typeof raw !== 'object') throw new Error('Inställningsfilen ser inte ut som en Revit-IFC-uppsättning.');
  const known = [], unknown = [];
  for (const k in raw) {
    const v = raw[k];
    if (v !== null && typeof v === 'object') continue;
    const meta = REVIT_SETTINGS[k];
    if (meta) known.push({ key: k, value: v, label: meta.label, tab: meta.tab, kind: meta.kind });
    else unknown.push({ key: k, value: v });
  }
  if (!known.length) throw new Error('Filen innehåller inga kända Revit-inställningar. Är det rätt fil? ' +
                                     'Den exporteras från "Modify setup" i IFC-exporten.');
  return { raw: raw, known: known, unknown: unknown, name: typeof raw.Name === 'string' ? raw.Name : '' };
}

