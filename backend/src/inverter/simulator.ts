import {
  deriveStatuses,
  type FullReading,
  type InverterConfig,
  type InverterSource,
  type LiveReading,
} from "./types.js";

/** Deterministic pseudo-random from a seed (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

/** Daily "weather factor" 0.25..1 — cloudy vs sunny days, seeded by date. */
export function weatherFactorFor(date: Date): number {
  const seed = date.getFullYear() * 1000 + dayOfYear(date);
  const rnd = seededRandom(seed);
  const r = rnd();
  if (r < 0.2) return 0.25 + rnd() * 0.2; // overcast
  if (r < 0.45) return 0.5 + rnd() * 0.25; // mixed
  return 0.8 + rnd() * 0.2; // sunny
}

/** Seasonal daylight model (northern hemisphere). */
export function sunWindow(date: Date): { sunrise: number; sunset: number } {
  const doy = dayOfYear(date);
  const seasonal = Math.cos(((doy - 172) / 365) * 2 * Math.PI); // 1 at summer solstice
  const dayLength = 12 + 4.2 * seasonal; // 7.8h winter .. 16.2h summer
  return { sunrise: 13 - dayLength / 2, sunset: 13 + dayLength / 2 };
}

/** Expected PV power (W) for a time of day, before weather. */
export function clearSkyPvW(date: Date, hourOfDay: number, kwp: number): number {
  const { sunrise, sunset } = sunWindow(date);
  if (hourOfDay <= sunrise || hourOfDay >= sunset) return 0;
  const x = (hourOfDay - sunrise) / (sunset - sunrise); // 0..1
  const bell = Math.sin(Math.PI * x) ** 1.5;
  const doy = dayOfYear(date);
  const seasonal = 0.65 + 0.35 * Math.cos(((doy - 172) / 365) * 2 * Math.PI);
  return kwp * 1000 * bell * seasonal;
}

/** Typical household load (W) for a time of day. */
export function householdLoadW(hourOfDay: number, rnd: () => number): number {
  let load = 250; // base: fridge, router, standby
  if (hourOfDay >= 6.5 && hourOfDay < 9) load += 600; // breakfast
  if (hourOfDay >= 12 && hourOfDay < 14) load += 350; // lunch
  if (hourOfDay >= 18 && hourOfDay < 23) load += 900; // evening
  if (hourOfDay >= 23 || hourOfDay < 6.5) load -= 80; // night
  // Random appliance spikes (kettle, oven, washing machine).
  if (rnd() < 0.04) load += 1200 + rnd() * 1500;
  return Math.max(120, load + (rnd() - 0.5) * 120);
}

export interface SimulatorOptions {
  kwp?: number;
  batteryCapacityKwh?: number;
  /** Speed multiplier for tests. */
  now?: () => Date;
  /** 3 simulates a three-phase hybrid (per-phase loads and voltages). */
  phases?: 1 | 3;
  /** Fixed RNG seed for deterministic tests. */
  seed?: number;
}

/**
 * Simulated hybrid inverter with battery physics, realistic PV/load
 * curves, daily counters and occasional grid outages.
 */
export class SimulatedInverter implements InverterSource {
  private readonly kwp: number;
  private readonly capacityKwh: number;
  private readonly now: () => Date;
  private readonly phases: 1 | 3;
  private rnd: () => number;

  private soc = 65;
  private lastTickMs: number | null = null;
  private counters = {
    date: "",
    pvKwh: 0,
    importKwh: 0,
    exportKwh: 0,
    loadKwh: 0,
    battChargeKwh: 0,
    battDischargeKwh: 0,
  };
  private outageUntilMs: number | null = null;
  private totalPvKwh = 4210; // pretend lifetime total

  constructor(opts: SimulatorOptions = {}) {
    this.kwp = opts.kwp ?? 5.5;
    this.capacityKwh = opts.batteryCapacityKwh ?? 16;
    this.now = opts.now ?? (() => new Date());
    this.phases = opts.phases ?? 1;
    this.rnd = seededRandom(opts.seed ?? (Date.now() & 0xffffffff));
  }

  async close(): Promise<void> {}

  async detectConfig(): Promise<InverterConfig> {
    return { phases: this.phases, hasBattery: true, pvStrings: 2, hasGenerator: false };
  }

  private tick(): LiveReading {
    const date = this.now();
    const nowMs = date.getTime();
    const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
    const dtH = this.lastTickMs
      ? Math.min(60, (nowMs - this.lastTickMs) / 1000) / 3600
      : 0;
    this.lastTickMs = nowMs;

    // Reset daily counters at midnight.
    const dayKey = date.toISOString().slice(0, 10);
    if (this.counters.date !== dayKey) {
      this.counters = {
        date: dayKey,
        pvKwh: 0, importKwh: 0, exportKwh: 0, loadKwh: 0,
        battChargeKwh: 0, battDischargeKwh: 0,
      };
    }

    // Occasional outages (~1 per week on average, 30-120 min).
    if (this.outageUntilMs !== null && nowMs > this.outageUntilMs) {
      this.outageUntilMs = null;
    }
    if (this.outageUntilMs === null && this.rnd() < 0.00012) {
      this.outageUntilMs = nowMs + (30 + this.rnd() * 90) * 60000;
    }
    const gridUp = this.outageUntilMs === null;

    const weather = weatherFactorFor(date);
    const flicker = 0.9 + this.rnd() * 0.2;
    const pvW = Math.round(clearSkyPvW(date, hour, this.kwp) * weather * flicker);
    const pv1W = Math.round(pvW * 0.55);
    const pv2W = pvW - pv1W;
    let loadW = Math.round(householdLoadW(hour, this.rnd));

    // Battery physics: charge from surplus, discharge to cover deficit.
    const surplus = pvW - loadW;
    let battW = 0; // + charging
    let gridW = 0; // + importing
    if (surplus >= 0) {
      const chargeW = this.soc >= 99.5 ? 0 : Math.min(surplus, 5500);
      battW = chargeW;
      gridW = gridUp ? -(surplus - chargeW) : 0; // export remainder
    } else {
      const deficit = -surplus;
      const minSoc = gridUp ? 20 : 8;
      const dischargeW = this.soc <= minSoc ? 0 : Math.min(deficit, 6000);
      battW = -dischargeW;
      if (gridUp) {
        gridW = deficit - dischargeW;
      } else {
        // Off grid: shed load we cannot cover.
        loadW = pvW + dischargeW;
        gridW = 0;
      }
    }

    // Integrate SOC and daily counters.
    if (dtH > 0) {
      const effIn = 0.96;
      const effOut = 0.96;
      const deltaKwh =
        battW > 0 ? (battW / 1000) * dtH * effIn : (battW / 1000) * dtH / effOut;
      this.soc = Math.min(100, Math.max(5, this.soc + (deltaKwh / this.capacityKwh) * 100));
      this.counters.pvKwh += (pvW / 1000) * dtH;
      this.counters.loadKwh += (loadW / 1000) * dtH;
      if (gridW > 0) this.counters.importKwh += (gridW / 1000) * dtH;
      if (gridW < 0) this.counters.exportKwh += (-gridW / 1000) * dtH;
      if (battW > 0) this.counters.battChargeKwh += (battW / 1000) * dtH;
      if (battW < 0) this.counters.battDischargeKwh += (-battW / 1000) * dtH;
      this.totalPvKwh += (pvW / 1000) * dtH;
    }

    const battV = 48 + (this.soc / 100) * 5.2 + (battW > 0 ? 0.3 : -0.2);
    const battA = battV > 0 ? battW / battV : 0;
    const gridV = gridUp ? 228 + this.rnd() * 10 : 0;
    const soc = Math.round(this.soc);

    const statuses = deriveStatuses({ battA, gridW, gridV, hasBattery: true });

    // Per-phase split (3-phase only): fixed shares that sum exactly to loadW,
    // and slightly unbalanced phase voltages around gridV. No rnd() calls in
    // this branch, so enabling it never changes the 1-phase sequence.
    const roundV = (v: number) => Math.round(v * 10) / 10;
    const totalLoad = Math.round(loadW);
    const l1W = this.phases === 3 ? Math.round(totalLoad * 0.45) : totalLoad;
    const l2W = this.phases === 3 ? Math.round(totalLoad * 0.33) : null;
    const l3W = this.phases === 3 ? totalLoad - l1W - (l2W ?? 0) : null;

    return {
      pv1W, pv2W, pvW,
      battW: Math.round(battW),
      battV: Math.round(battV * 100) / 100,
      battA: Math.round(battA * 100) / 100,
      soc,
      socRaw: soc,
      gridV: roundV(gridV),
      gridW: Math.round(gridW),
      gridHz: gridUp ? 49.98 + this.rnd() * 0.06 : null,
      loadW: totalLoad,
      genW: 0,
      l1W,
      l2W,
      l3W,
      l1V: roundV(gridV),
      l2V: this.phases === 3 ? roundV(gridV * 1.004) : null,
      l3V: this.phases === 3 ? roundV(gridV * 0.996) : null,
      ...statuses,
    };
  }

  async readLive(_config: InverterConfig): Promise<LiveReading> {
    return this.tick();
  }

  async readFull(_config: InverterConfig): Promise<FullReading> {
    const live = this.tick();
    const round1 = (v: number) => Math.round(v * 10) / 10;
    return {
      ...live,
      dcTemp: round1(32 + live.pvW / 400 + this.rnd() * 2),
      heatsinkTemp: round1(28 + live.pvW / 500 + this.rnd() * 2),
      dailyPvKwh: round1(this.counters.pvKwh),
      dailyImportKwh: round1(this.counters.importKwh),
      dailyExportKwh: round1(this.counters.exportKwh),
      dailyLoadKwh: round1(this.counters.loadKwh),
      dailyBattChargeKwh: round1(this.counters.battChargeKwh),
      dailyBattDischargeKwh: round1(this.counters.battDischargeKwh),
      totalPvKwh: round1(this.totalPvKwh),
      batteryCapacityAh: 314,
      batteryNominalV: 51,
    };
  }
}
