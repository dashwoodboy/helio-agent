import { describe, expect, it } from "vitest";
import { computeFlows } from "../src/services/flows.js";

describe("energy flow attribution", () => {
  it("solar surplus charges battery then exports", () => {
    const flows = computeFlows({ pvW: 5000, loadW: 1000, gridW: -1500, battW: 2500, genW: 0 });
    expect(flows.pvToLoadW).toBe(1000);
    expect(flows.pvToBattW).toBe(2500);
    expect(flows.pvToGridW).toBe(1500);
    expect(flows.gridToLoadW).toBe(0);
    expect(flows.battToLoadW).toBe(0);
  });

  it("night load served by battery", () => {
    const flows = computeFlows({ pvW: 0, loadW: 800, gridW: 0, battW: -800, genW: 0 });
    expect(flows.battToLoadW).toBe(800);
    expect(flows.gridToLoadW).toBe(0);
    expect(flows.pvToLoadW).toBe(0);
  });

  it("battery empty: grid covers the load", () => {
    const flows = computeFlows({ pvW: 0, loadW: 1200, gridW: 1200, battW: 0, genW: 0 });
    expect(flows.gridToLoadW).toBe(1200);
    expect(flows.battToLoadW).toBe(0);
  });

  it("grid charges the battery when PV is insufficient", () => {
    const flows = computeFlows({ pvW: 500, loadW: 300, gridW: 1800, battW: 2000, genW: 0 });
    expect(flows.pvToLoadW).toBe(300);
    expect(flows.pvToBattW).toBe(200);
    expect(flows.gridToBattW).toBe(1800);
    expect(flows.gridToLoadW).toBe(0);
  });

  it("generator covers load during an outage with empty battery", () => {
    const flows = computeFlows({ pvW: 200, loadW: 2000, gridW: 0, battW: 0, genW: 1800 });
    expect(flows.pvToLoadW).toBe(200);
    expect(flows.genToLoadW).toBe(1800);
  });

  it("mixed midday: pv covers load, charges, exports while grid idle", () => {
    const flows = computeFlows({ pvW: 4000, loadW: 1500, gridW: -500, battW: 2000, genW: 0 });
    expect(flows.pvToLoadW).toBe(1500);
    expect(flows.pvToBattW).toBe(2000);
    expect(flows.pvToGridW).toBe(500);
  });

  it("generator surplus charges the battery before the grid", () => {
    const flows = computeFlows({ pvW: 0, loadW: 1000, gridW: 500, battW: 1500, genW: 2000 });
    // load priority: pv(0) -> batt(0, charging) -> grid(500) -> gen(500)
    expect(flows.gridToLoadW).toBe(500);
    expect(flows.genToLoadW).toBe(500);
    expect(flows.genToBattW).toBe(1500);
    expect(flows.gridToBattW).toBe(0);
    expect(flows.acPvToBattW).toBe(0);
  });

  it("charge that solar, grid and generator can't explain becomes AC coupling", () => {
    // battery charges 2 kW while the grid only covers the load and PV is dark
    const flows = computeFlows({ pvW: 0, loadW: 500, gridW: 500, battW: 2000, genW: 0 });
    expect(flows.gridToLoadW).toBe(500);
    expect(flows.gridToBattW).toBe(0);
    expect(flows.acPvToBattW).toBe(2000);
  });

  it("grid import is consumed before anything is called AC coupling", () => {
    const flows = computeFlows({ pvW: 0, loadW: 0, gridW: 1000, battW: 2500, genW: 0 });
    expect(flows.gridToBattW).toBe(1000);
    expect(flows.acPvToBattW).toBe(1500);
    // sources always conserve the total charge power
    expect(flows.pvToBattW + flows.genToBattW + flows.gridToBattW + flows.acPvToBattW).toBe(2500);
  });

  it("generator and grid both take their share before the AC-coupling residual", () => {
    const flows = computeFlows({ pvW: 0, loadW: 0, gridW: 500, battW: 3000, genW: 1000 });
    expect(flows.genToBattW).toBe(1000);
    expect(flows.gridToBattW).toBe(500);
    expect(flows.acPvToBattW).toBe(1500);
  });

  it("a residual below the noise floor is not attributed to AC coupling", () => {
    // 30 W under the 50 W absolute floor
    const small = computeFlows({ pvW: 1970, loadW: 0, gridW: 0, battW: 2000, genW: 0 });
    expect(small.pvToBattW).toBe(1970);
    expect(small.acPvToBattW).toBe(0);
    // 250 W under the 3% floor (300 W of a 10 kW charge)
    const relative = computeFlows({ pvW: 9750, loadW: 0, gridW: 0, battW: 10000, genW: 0 });
    expect(relative.acPvToBattW).toBe(0);
  });

  it("a real residual above the floor is attributed and conserves totals", () => {
    const flows = computeFlows({ pvW: 1500, loadW: 300, gridW: 300, battW: 2400, genW: 0 });
    expect(flows.pvToLoadW).toBe(300);
    expect(flows.pvToBattW).toBe(1200);
    expect(flows.gridToBattW).toBe(300);
    expect(flows.acPvToBattW).toBe(900);
    expect(flows.pvToBattW + flows.genToBattW + flows.gridToBattW + flows.acPvToBattW).toBe(2400);
  });
});
