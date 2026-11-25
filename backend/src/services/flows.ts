/**
 * Per-sample energy-flow attribution.
 *
 * Sign conventions: battW positive = charging, gridW positive = importing.
 * Load is served in priority order PV -> battery -> grid -> generator;
 * PV surplus goes battery -> grid export.
 *
 * Battery charge is attributed to sources in priority order:
 * DC PV strings -> generator -> grid -> AC coupling (the residual).
 */
export interface EnergyFlows {
  pvToLoadW: number;
  pvToBattW: number;
  pvToGridW: number;
  gridToLoadW: number;
  gridToBattW: number;
  battToLoadW: number;
  genToLoadW: number;
  genToBattW: number;
  /**
   * Battery charging that solar, generator and grid can't explain — an
   * AC-coupled source (e.g. a second PV inverter on the output side).
   * Inferred, not measured.
   */
  acPvToBattW: number;
}

/**
 * Residuals below this are measurement skew, not an AC-coupled source: the
 * inverter's registers are read a moment apart, so tens of watts of
 * disagreement between them are normal.
 */
const AC_NOISE_FLOOR_W = 50;
/** ... and on large charge powers the skew scales, so also require 3%. */
const AC_NOISE_FLOOR_PCT = 0.03;

export function computeFlows(sample: {
  pvW: number;
  loadW: number;
  gridW: number;
  battW: number;
  genW: number;
}): EnergyFlows {
  const pv = Math.max(0, sample.pvW);
  const load = Math.max(0, sample.loadW);
  const gen = Math.max(0, sample.genW);
  const gridImport = Math.max(0, sample.gridW);
  const gridExport = Math.max(0, -sample.gridW);
  const battCharge = Math.max(0, sample.battW);
  const battDischarge = Math.max(0, -sample.battW);

  const pvToLoad = Math.min(pv, load);
  let pvLeft = pv - pvToLoad;
  const pvToBatt = Math.min(pvLeft, battCharge);
  pvLeft -= pvToBatt;
  const pvToGrid = Math.min(pvLeft, gridExport);

  let loadLeft = load - pvToLoad;
  const battToLoad = Math.min(battDischarge, loadLeft);
  loadLeft -= battToLoad;
  const gridToLoad = Math.min(gridImport, loadLeft);
  loadLeft -= gridToLoad;
  const genToLoad = Math.min(gen, loadLeft);

  // AC-side charge (whatever DC PV couldn't cover), attributed in order:
  // generator leftovers, then grid import, then — if something still
  // remains — an AC-coupled source.
  let acCharge = Math.max(0, battCharge - pvToBatt);
  const genToBatt = Math.min(Math.max(0, gen - genToLoad), acCharge);
  acCharge -= genToBatt;
  const gridToBatt = Math.min(Math.max(0, gridImport - gridToLoad), acCharge);
  acCharge -= gridToBatt;
  const acPvToBatt =
    acCharge >= Math.max(AC_NOISE_FLOOR_W, battCharge * AC_NOISE_FLOOR_PCT) ? acCharge : 0;

  return {
    pvToLoadW: pvToLoad,
    pvToBattW: pvToBatt,
    pvToGridW: pvToGrid,
    gridToLoadW: gridToLoad,
    gridToBattW: gridToBatt,
    battToLoadW: battToLoad,
    genToLoadW: genToLoad,
    genToBattW: genToBatt,
    acPvToBattW: acPvToBatt,
  };
}
