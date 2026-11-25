import { describe, expect, it } from "vitest";
import { DeyeInverter } from "../src/inverter/reader.js";
import { SimulatedInverter } from "../src/inverter/simulator.js";
import {
  registersFrom1p,
  registersFrom3p,
  SimulatedRegisterTransport,
} from "../src/inverter/registerImage.js";
import type { FullReading, InverterConfig } from "../src/inverter/types.js";
import type { RegisterTransport } from "../src/solarman/transport.js";

/** Register-map-backed fake: unset registers read as 0. */
function fakeTransport(regs: Record<number, number>): RegisterTransport {
  return {
    async connect() {},
    async disconnect() {},
    async readHoldingRegisters(start, quantity) {
      return Array.from({ length: quantity }, (_, i) => regs[start + i] ?? 0);
    },
  };
}

/**
 * Strict image-backed fake: like the real inverter, addresses missing from
 * the image fail with "illegal data address", and every read is counted.
 */
function imageTransport(regs: Map<number, number>): RegisterTransport & { reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    async connect() {},
    async disconnect() {},
    async readHoldingRegisters(start, quantity) {
      reads++;
      const out: number[] = [];
      for (let i = 0; i < quantity; i++) {
        const v = regs.get(start + i);
        if (v === undefined) throw new Error("Modbus exception code 2 (illegal data address)");
        out.push(v);
      }
      return out;
    },
  };
}

const config = (phases: 1 | 3): InverterConfig => ({
  phases,
  hasBattery: true,
  pvStrings: 2,
  hasGenerator: false,
});

/**
 * Deterministic simulator reading at a given local hour: warm up for two
 * hours in 30 s ticks so the daily counters accumulate, then capture one
 * full reading.
 */
async function readingAt(phases: 1 | 3, hour: number): Promise<FullReading> {
  let t = new Date(2026, 5, 15, hour - 2, 0, 0).getTime();
  const sim = new SimulatedInverter({
    kwp: 5.5,
    batteryCapacityKwh: 16,
    phases,
    seed: 42,
    now: () => new Date(t),
  });
  for (let i = 0; i < 240; i++) {
    t += 30000;
    await sim.readLive(config(phases));
  }
  return sim.readFull(config(phases));
}

/** Assert the reader's output matches the reading the image was built from. */
function expectRoundTrip(got: FullReading, want: FullReading, opts: { pvTolW?: number } = {}) {
  const pvTol = opts.pvTolW ?? 0;
  expect(Math.abs(got.pv1W - want.pv1W)).toBeLessThanOrEqual(pvTol);
  expect(Math.abs(got.pv2W - want.pv2W)).toBeLessThanOrEqual(pvTol);
  expect(Math.abs(got.pvW - want.pvW)).toBeLessThanOrEqual(2 * pvTol);
  expect(got.loadW).toBe(want.loadW);
  expect(got.gridW).toBe(want.gridW);
  expect(Math.abs(got.battW - want.battW)).toBeLessThanOrEqual(2);
  expect(got.battV).toBeCloseTo(want.battV, 1);
  expect(got.battA).toBeCloseTo(want.battA, 1);
  expect(got.soc).toBe(want.soc);
  expect(got.gridV).toBeCloseTo(want.gridV, 2);
  if (want.gridHz === null) expect(got.gridHz).toBeNull();
  else expect(got.gridHz).toBeCloseTo(want.gridHz, 2);
  expect(got.l1W).toBe(want.l1W);
  expect(got.l2W).toBe(want.l2W);
  expect(got.l3W).toBe(want.l3W);
  expect(got.l1V).toBeCloseTo(want.l1V ?? 0, 2);
  if (want.l2V === null) expect(got.l2V).toBeNull();
  else expect(got.l2V).toBeCloseTo(want.l2V, 2);
  expect(got.batteryStatus).toBe(want.batteryStatus);
  expect(got.gridStatus).toBe(want.gridStatus);
  // Slow values / daily counters.
  expect(got.dcTemp).toBeCloseTo(want.dcTemp ?? 0, 5);
  expect(got.heatsinkTemp).toBeCloseTo(want.heatsinkTemp ?? 0, 5);
  expect(got.dailyPvKwh).toBeCloseTo(want.dailyPvKwh, 5);
  expect(got.dailyImportKwh).toBeCloseTo(want.dailyImportKwh, 5);
  expect(got.dailyExportKwh).toBeCloseTo(want.dailyExportKwh, 5);
  expect(got.dailyLoadKwh).toBeCloseTo(want.dailyLoadKwh, 5);
  expect(got.dailyBattChargeKwh).toBeCloseTo(want.dailyBattChargeKwh ?? 0, 5);
  expect(got.dailyBattDischargeKwh).toBeCloseTo(want.dailyBattDischargeKwh ?? 0, 5);
  expect(got.totalPvKwh).toBeCloseTo(want.totalPvKwh ?? 0, 5);
}

// ------------------------------------------------- round-trip: 1-phase

describe("1-phase round trip (simulator -> register image -> reader)", () => {
  it("midday reading survives the round trip unchanged", async () => {
    const want = await readingAt(1, 13);
    const inv = new DeyeInverter(imageTransport(registersFrom1p(want)));
    const got = await inv.readFull(config(1));
    expect(want.pvW).toBeGreaterThan(500); // sanity: the sun is up
    expectRoundTrip(got, want);
  });

  it("night reading: no PV, no export", async () => {
    const want = await readingAt(1, 2);
    const inv = new DeyeInverter(imageTransport(registersFrom1p(want)));
    const got = await inv.readFull(config(1));
    expect(want.pvW).toBe(0);
    expectRoundTrip(got, want);
    expect(got.pvW).toBe(0);
    expect(got.gridW).toBeGreaterThanOrEqual(0); // never "exporting" at night
    expect(got.dailyExportKwh).toBe(0);
  });
});

// ------------------------------------------------- round-trip: 3-phase

describe("3-phase LV round trip (SG04LP3 map)", () => {
  it("midday reading survives the round trip unchanged", async () => {
    const want = await readingAt(3, 13);
    const inv = new DeyeInverter(imageTransport(registersFrom3p(want)));
    const got = await inv.readFull(config(3));
    expect(want.pvW).toBeGreaterThan(500);
    expectRoundTrip(got, want);
  });

  it("night reading: no phantom PV, no phantom export (customer regression)", async () => {
    const want = await readingAt(3, 2);
    const inv = new DeyeInverter(imageTransport(registersFrom3p(want)));
    const got = await inv.readFull(config(3));
    expect(want.pvW).toBe(0);
    expectRoundTrip(got, want);
    expect(got.pvW).toBe(0);
    expect(got.gridW).toBeGreaterThanOrEqual(0);
    expect(got.gridStatus).not.toBe("exporting");
    expect(got.dailyPvKwh).toBe(0);
    expect(got.dailyExportKwh).toBe(0);
    // At night the battery carries the load.
    expect(got.battW).toBeLessThan(0);
    expect(got.batteryStatus).toBe("discharging");
  });
});

describe("3-phase HV round trip (SG01HP3 scales: 0.1 V battery, 10 W PV)", () => {
  it("midday reading survives the round trip within the 10 W PV step", async () => {
    const want = await readingAt(3, 13);
    const inv = new DeyeInverter(imageTransport(registersFrom3p(want, { hv: true })));
    const got = await inv.readFull({ ...config(3), hv: true });
    expectRoundTrip(got, want, { pvTolW: 10 });
  });

  it("night reading: zeros stay zeros", async () => {
    const want = await readingAt(3, 2);
    const inv = new DeyeInverter(imageTransport(registersFrom3p(want, { hv: true })));
    const got = await inv.readFull({ ...config(3), hv: true });
    expect(got.pvW).toBe(0);
    expect(got.gridStatus).not.toBe("exporting");
    expect(got.dailyPvKwh).toBe(0);
  });
});

// ---------------------------------------------------------- detection

describe("capability detection against register images", () => {
  it("detects a 1-phase inverter from the 1-phase image", async () => {
    const want = await readingAt(1, 13);
    const inv = new DeyeInverter(imageTransport(registersFrom1p(want)));
    const cfg = await inv.detectConfig();
    expect(cfg.phases).toBe(1);
  });

  it("detects 3-phase LV (device type 0x0500)", async () => {
    const want = await readingAt(3, 13);
    const inv = new DeyeInverter(imageTransport(registersFrom3p(want)));
    const cfg = await inv.detectConfig();
    expect(cfg.phases).toBe(3);
    expect(cfg.hv).toBe(false);
  });

  it("detects 3-phase HV (device type 0x0601)", async () => {
    const want = await readingAt(3, 13);
    const inv = new DeyeInverter(imageTransport(registersFrom3p(want, { hv: true })));
    const cfg = await inv.detectConfig();
    expect(cfg.phases).toBe(3);
    expect(cfg.hv).toBe(true);
  });
});

describe("cached config shortcut", () => {
  it("a complete 1-phase cached config reads no registers at all", async () => {
    const transport = imageTransport(new Map());
    const inv = new DeyeInverter(transport, {
      phases: 1,
      hasBattery: true,
      pvStrings: 2,
      hasGenerator: false,
    });
    const cfg = await inv.detectConfig();
    expect(cfg.phases).toBe(1);
    expect(transport.reads()).toBe(0);
  });

  it("a 3-phase cached config without hv re-detects hv once", async () => {
    const want = await readingAt(3, 13);
    const transport = imageTransport(registersFrom3p(want, { hv: true }));
    const inv = new DeyeInverter(transport, {
      phases: 3,
      hasBattery: true,
      pvStrings: 2,
      hasGenerator: false,
    });
    const cfg = await inv.detectConfig();
    expect(cfg.phases).toBe(3);
    expect(cfg.hv).toBe(true);
    expect(transport.reads()).toBe(1); // just the device-type register
  });

  it("a 3-phase cached config with hv reads nothing", async () => {
    const transport = imageTransport(new Map());
    const inv = new DeyeInverter(transport, {
      phases: 3,
      hasBattery: true,
      pvStrings: 2,
      hasGenerator: false,
      hv: false,
    });
    const cfg = await inv.detectConfig();
    expect(cfg.hv).toBe(false);
    expect(transport.reads()).toBe(0);
  });
});

// --------------------------------------- simulated register transport

describe("SimulatedRegisterTransport", () => {
  it("serves coherent 3-phase blocks that the reader interprets back", async () => {
    let t = new Date(2026, 5, 15, 13, 0, 0).getTime();
    const sim = new SimulatedInverter({
      kwp: 5.5,
      phases: 3,
      seed: 7,
      now: () => new Date(t),
    });
    const transport = new SimulatedRegisterTransport(sim, {
      phases: 3,
      refreshMs: 1000,
      now: () => t,
    });
    const inv = new DeyeInverter(transport);
    const live = await inv.readLive(config(3));
    expect(live.pvW).toBeGreaterThan(0);
    expect(live.loadW).toBeGreaterThan(0);
    expect((live.l1W ?? 0) + (live.l2W ?? 0) + (live.l3W ?? 0)).toBe(live.loadW);
    t += 5000; // next poll gets a fresh image
    const next = await inv.readLive(config(3));
    expect(next.soc).toBeGreaterThanOrEqual(0);
  });
});

// ------------------------------------------------- existing 1p tests

const CONFIG: InverterConfig = { phases: 1, hasBattery: true, pvStrings: 2, hasGenerator: false };

describe("1-phase total PV counter", () => {
  it("reads the 32-bit total low word first (reg 96 = low, reg 97 = high)", async () => {
    // A new inverter with 28.9 kWh lifetime: raw 289 in the low word, 0 in the high word.
    const inv = new DeyeInverter(fakeTransport({ 96: 289, 97: 0 }));
    const full = await inv.readFull(CONFIG);
    expect(full.totalPvKwh).toBe(28.9);
  });

  it("combines both words for totals above 6553.5 kWh", async () => {
    // 100000.0 kWh = raw 1,000,000 = 15 * 65536 + 16960
    const inv = new DeyeInverter(fakeTransport({ 96: 16960, 97: 15 }));
    const full = await inv.readFull(CONFIG);
    expect(full.totalPvKwh).toBe(100000);
  });
});
