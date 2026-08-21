/* ==========================================================================
   05-options.js  ·  inställningar och förinställningar
   Laddas både i gränssnittet och i webbarbetaren.
   ========================================================================== */

function decimalsFor(unitFactor, tolMetres) {
  const tolU = tolMetres / (unitFactor || 1);
  const d = Math.ceil(-Math.log10(tolU));
  return Math.max(0, Math.min(9, isFinite(d) ? d : 3));
}

function baseOptions() {
  return {
    roundCoords: true, coordDec: 2, ratioDec: 9, tolMm: 0.01,
    dedup: true, unifyOwnerHistory: true, gc: true, renumber: true, stamp: true,
    dropPsets: false, dropQuantities: false, dropTypes: false, dropMaterials: false,
    dropStyles: false, dropLayers: false, dropClassifications: false,
    dropConnectivity: false, drop2D: false, dropGrids: false, dropSpaces: false,
    dropSpaceBoundaries: false, dropOpenings: false, dropClasses: [],
    mergeCoplanar: false, weld: false, weldTolMm: 0.5, boxify: false,
    zip: false, verify: true, suffix: '_optimerad'
  };
}

const PRESET_KEYS = ['latt', 'medel', 'aggressiv'];

function presetOptions(preset) {
  const o = baseOptions();
  if (preset === 'medel' || preset === 'aggressiv') {
    o.dropPsets = true; o.dropQuantities = true; o.dropTypes = true;
    o.dropMaterials = true; o.dropClassifications = true; o.dropConnectivity = true;
    o.drop2D = true; o.dropLayers = true; o.dropSpaceBoundaries = true;
    o.mergeCoplanar = true;
  }
  if (preset === 'aggressiv') {
    o.dropStyles = true; o.dropSpaces = true; o.dropOpenings = true;
    o.dropGrids = true; o.weld = true; o.zip = true;
  }
  return o;
}
