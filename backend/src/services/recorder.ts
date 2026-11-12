import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { dailyEnergy, telemetry } from "../db/schema.js";
import type { FullReading, LiveReading } from "../inverter/types.js";
import { localDateKey, localHour, localSlot } from "../lib/time.js";
import { computeFlows, type EnergyFlows } from "./flows.js";
import type { SettingsService } from "./settings.js";
import { SLOTS_PER_DAY } from "./tariff.js";

export { localDateKey } from "../lib/time.js";

/** Max believable gap between samples; longer gaps are not integrated. */
const MAX_GAP_S = 60;

interface MinuteAccumulator {
  n: number;
  sums: Record<string, number>;
  last: LiveReading | null;
}

interface DayAccumulator {
  date: string;
  // Integrated Wh values
  pvWh: number;
  importWh: number;
  exportWh: number;
  loadWh: number;
  battChargeWh: number;
  battDischargeWh: number;
  genWh: number;
  flowsWh: Record<keyof EnergyFlows, number>;
  importDayWh: number;
  importNightWh: number;
  /** Imported energy per half-hour slot (48 buckets, Wh) for custom tariffs. */
  importSlotsWh: number[];
  l1Wh: number;
  l2Wh: number;
  l3Wh: number;
  peakPvW: number;
  peakLoadW: number;
  socMin: number | null;
  socMax: number | null;
  battVMin: number | null;
  battVMax: number | null;
  // Authoritative counters from the inverter (if seen)
  counters: {
    pvKwh: number;
    importKwh: number;
    exportKwh: number;
    loadKwh: number;
    battChargeKwh: number | null;
    battDischargeKwh: number | null;
  } | null;
}

function emptyDay(date: string): DayAccumulator {
  return {
    date,
    pvWh: 0, importWh: 0, exportWh: 0, loadWh: 0,
    battChargeWh: 0, battDischargeWh: 0, genWh: 0,
    flowsWh: {
      pvToLoadW: 0, pvToBattW: 0, pvToGridW: 0,
      gridToLoadW: 0, gridToBattW: 0, battToLoadW: 0, genToLoadW: 0,
      genToBattW: 0, acPvToBattW: 0,
    },
    importDayWh: 0, importNightWh: 0,
    importSlotsWh: new Array<number>(SLOTS_PER_DAY).fill(0),
    l1Wh: 0, l2Wh: 0, l3Wh: 0,
    peakPvW: 0, peakLoadW: 0,
    socMin: null, socMax: null, battVMin: null, battVMax: null,
    counters: null,
  };
}

/**
 * Buffers live samples, integrates energy with a max-gap guard, writes
 * 1-minute telemetry rows and keeps the current day's daily_energy row
 * up to date (inverter counters win over integration when available).
 */
export class Recorder {
  private minute: MinuteAccumulator = { n: 0, sums: {}, last: null };
  private day: DayAccumulator;
  private lastSampleMs: number | null = null;
  private lastFlushMs = 0;
  private lastTemps: { dcTemp: number | null; heatsinkTemp: number | null } = {
    dcTemp: null,
    heatsinkTemp: null,
  };

  constructor(
    private readonly db: Db,
    private readonly settingsService: SettingsService,
    private readonly environmentId: string,
    /** IANA timezone for day boundaries; process-local when omitted. */
    private readonly tz?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = emptyDay(localDateKey(this.now(), this.tz));
  }

  /** Resume today's accumulators from the DB after a restart. */
  async init(): Promise<void> {
    const rows = await this.db
      .select()
      .from(dailyEnergy)
      .where(
        and(
          eq(dailyEnergy.environmentId, this.environmentId),
          eq(dailyEnergy.date, this.day.date),
        ),
      );
    if (rows.length === 0) return;
    const r = rows[0];
    const d = this.day;
    d.pvWh = r.pvKwh * 1000;
    d.importWh = r.importKwh * 1000;
    d.exportWh = r.exportKwh * 1000;
    d.loadWh = r.loadKwh * 1000;
    d.battChargeWh = r.battChargeKwh * 1000;
    d.battDischargeWh = r.battDischargeKwh * 1000;
    d.genWh = r.genKwh * 1000;
    d.flowsWh.pvToLoadW = r.pvToLoadKwh * 1000;
    d.flowsWh.pvToBattW = r.pvToBattKwh * 1000;
    d.flowsWh.pvToGridW = r.pvToGridKwh * 1000;
    d.flowsWh.gridToLoadW = r.gridToLoadKwh * 1000;
    d.flowsWh.gridToBattW = r.gridToBattKwh * 1000;
    d.flowsWh.battToLoadW = r.battToLoadKwh * 1000;
    d.flowsWh.genToBattW = r.genToBattKwh * 1000;
    d.flowsWh.acPvToBattW = r.acPvToBattKwh * 1000;
    d.importDayWh = r.importDayKwh * 1000;
    d.importNightWh = r.importNightKwh * 1000;
    if (r.importSlotsKwh) {
      for (let i = 0; i < SLOTS_PER_DAY; i++) {
        d.importSlotsWh[i] = (r.importSlotsKwh[i] ?? 0) * 1000;
      }
    }
    d.l1Wh = r.l1Kwh * 1000;
    d.l2Wh = r.l2Kwh * 1000;
    d.l3Wh = r.l3Kwh * 1000;
    d.peakPvW = r.peakPvW;
    d.peakLoadW = r.peakLoadW;
    d.socMin = r.socMin;
    d.socMax = r.socMax;
    d.battVMin = r.battVMin;
    d.battVMax = r.battVMax;
  }

  /** Today's integrated flow totals (kWh), for self-sufficiency figures. */
  todayFlowsKwh() {
    const f = this.day.flowsWh;
    return {
      pvToLoadKwh: f.pvToLoadW / 1000,
      pvToBattKwh: f.pvToBattW / 1000,
      pvToGridKwh: f.pvToGridW / 1000,
      gridToLoadKwh: f.gridToLoadW / 1000,
      gridToBattKwh: f.gridToBattW / 1000,
      battToLoadKwh: f.battToLoadW / 1000,
      loadKwh: this.day.counters?.loadKwh ?? this.day.loadWh / 1000,
      pvKwh: this.day.counters?.pvKwh ?? this.day.pvWh / 1000,
    };
  }

  async onFullRead(reading: FullReading): Promise<void> {
    this.lastTemps = { dcTemp: reading.dcTemp, heatsinkTemp: reading.heatsinkTemp };
    this.day.counters = {
      pvKwh: reading.dailyPvKwh,
      importKwh: reading.dailyImportKwh,
      exportKwh: reading.dailyExportKwh,
      loadKwh: reading.dailyLoadKwh,
      battChargeKwh: reading.dailyBattChargeKwh,
      battDischargeKwh: reading.dailyBattDischargeKwh,
    };
    await this.onSample(reading);
  }

  async onSample(reading: LiveReading): Promise<void> {
    const ts = this.now();
    const dateKey = localDateKey(ts, this.tz);
    if (dateKey !== this.day.date) {
      // Day rollover: write the final state of the old day, start fresh.
      await this.flushDaily();
      this.day = emptyDay(dateKey);
      this.lastSampleMs = null;
    }

    const flows = computeFlows(reading);
    const nowMs = ts.getTime();
    const dtS = this.lastSampleMs ? (nowMs - this.lastSampleMs) / 1000 : 0;
    this.lastSampleMs = nowMs;

    // Integrate energy only across believable gaps.
    if (dtS > 0 && dtS <= MAX_GAP_S) {
      const dtH = dtS / 3600;
      const d = this.day;
      d.pvWh += reading.pvW * dtH;
      d.loadWh += reading.loadW * dtH;
      if (reading.gridW > 0) {
        d.importWh += reading.gridW * dtH;
        const isNight = this.settingsService.isNightHour(localHour(ts, this.tz));
        if (isNight) d.importNightWh += reading.gridW * dtH;
        else d.importDayWh += reading.gridW * dtH;
        d.importSlotsWh[localSlot(ts, this.tz)] += reading.gridW * dtH;
      } else {
        d.exportWh += -reading.gridW * dtH;
      }
      if (reading.battW > 0) d.battChargeWh += reading.battW * dtH;
      else d.battDischargeWh += -reading.battW * dtH;
      d.genWh += reading.genW * dtH;
      for (const key of Object.keys(d.flowsWh) as (keyof EnergyFlows)[]) {
        d.flowsWh[key] += flows[key] * dtH;
      }
      if (reading.l1W != null) d.l1Wh += reading.l1W * dtH;
      if (reading.l2W != null) d.l2Wh += reading.l2W * dtH;
      if (reading.l3W != null) d.l3Wh += reading.l3W * dtH;
    }

    const d = this.day;
    d.peakPvW = Math.max(d.peakPvW, reading.pvW);
    d.peakLoadW = Math.max(d.peakLoadW, reading.loadW);
    if (reading.soc > 0 || d.socMin !== null) {
      d.socMin = d.socMin === null ? reading.soc : Math.min(d.socMin, reading.soc);
      d.socMax = d.socMax === null ? reading.soc : Math.max(d.socMax, reading.soc);
    }
    if (reading.battV > 0) {
      d.battVMin = d.battVMin === null ? reading.battV : Math.min(d.battVMin, reading.battV);
      d.battVMax = d.battVMax === null ? reading.battV : Math.max(d.battVMax, reading.battV);
    }

    // Minute buffer for telemetry rows.
    const m = this.minute;
    m.n++;
    m.last = reading;
    const add = (k: string, v: number | null) => {
      if (v === null) return;
      m.sums[k] = (m.sums[k] ?? 0) + v;
    };
    add("pv1W", reading.pv1W); add("pv2W", reading.pv2W); add("pvW", reading.pvW);
    add("loadW", reading.loadW); add("gridW", reading.gridW); add("battW", reading.battW);
    add("battV", reading.battV); add("battA", reading.battA); add("soc", reading.soc);
    add("gridV", reading.gridV); add("gridHz", reading.gridHz);
    add("genW", reading.genW);
    add("l1W", reading.l1W); add("l2W", reading.l2W); add("l3W", reading.l3W);
    add("l1V", reading.l1V); add("l2V", reading.l2V); add("l3V", reading.l3V);

    if (nowMs - this.lastFlushMs >= 60000) {
      this.lastFlushMs = nowMs;
      await this.flushMinute(ts);
      await this.flushDaily();
    }
  }

  private async flushMinute(ts: Date): Promise<void> {
    const m = this.minute;
    if (m.n === 0 || !m.last) return;
    const avg = (k: string, int = false): number | null => {
      if (!(k in m.sums)) return null;
      const v = m.sums[k] / m.n;
      return int ? Math.round(v) : Math.round(v * 100) / 100;
    };
    this.minute = { n: 0, sums: {}, last: null };
    await this.db.insert(telemetry).values({
      environmentId: this.environmentId,
      ts,
      pv1W: avg("pv1W", true) ?? 0,
      pv2W: avg("pv2W", true) ?? 0,
      pvW: avg("pvW", true) ?? 0,
      loadW: avg("loadW", true) ?? 0,
      gridW: avg("gridW", true) ?? 0,
      battW: avg("battW", true) ?? 0,
      battV: avg("battV"),
      battA: avg("battA"),
      soc: avg("soc"),
      gridV: avg("gridV"),
      gridHz: avg("gridHz"),
      genW: avg("genW", true) ?? 0,
      dcTemp: this.lastTemps.dcTemp,
      heatsinkTemp: this.lastTemps.heatsinkTemp,
      l1W: avg("l1W", true),
      l2W: avg("l2W", true),
      l3W: avg("l3W", true),
      l1V: avg("l1V"),
      l2V: avg("l2V"),
      l3V: avg("l3V"),
    });
  }

  async flushDaily(): Promise<void> {
    const d = this.day;
    const c = d.counters;
    const kwh = (wh: number) => Math.round(wh) / 1000;
    const row = {
      environmentId: this.environmentId,
      date: d.date,
      // Inverter daily counters are authoritative when present.
      pvKwh: c ? c.pvKwh : kwh(d.pvWh),
      importKwh: c ? c.importKwh : kwh(d.importWh),
      exportKwh: c ? c.exportKwh : kwh(d.exportWh),
      loadKwh: c ? c.loadKwh : kwh(d.loadWh),
      battChargeKwh: c?.battChargeKwh ?? kwh(d.battChargeWh),
      battDischargeKwh: c?.battDischargeKwh ?? kwh(d.battDischargeWh),
      genKwh: kwh(d.genWh),
      pvToLoadKwh: kwh(d.flowsWh.pvToLoadW),
      pvToBattKwh: kwh(d.flowsWh.pvToBattW),
      pvToGridKwh: kwh(d.flowsWh.pvToGridW),
      gridToLoadKwh: kwh(d.flowsWh.gridToLoadW),
      gridToBattKwh: kwh(d.flowsWh.gridToBattW),
      battToLoadKwh: kwh(d.flowsWh.battToLoadW),
      genToBattKwh: kwh(d.flowsWh.genToBattW),
      acPvToBattKwh: kwh(d.flowsWh.acPvToBattW),
      importDayKwh: kwh(d.importDayWh),
      importNightKwh: kwh(d.importNightWh),
      importSlotsKwh: d.importSlotsWh.map(kwh),
      peakPvW: d.peakPvW,
      peakLoadW: d.peakLoadW,
      l1Kwh: kwh(d.l1Wh),
      l2Kwh: kwh(d.l2Wh),
      l3Kwh: kwh(d.l3Wh),
      socMin: d.socMin,
      socMax: d.socMax,
      battVMin: d.battVMin,
      battVMax: d.battVMax,
      source: c ? "counters" : "integrated",
    };
    const { environmentId: _env, ...set } = row;
    await this.db
      .insert(dailyEnergy)
      .values(row)
      .onConflictDoUpdate({ target: [dailyEnergy.environmentId, dailyEnergy.date], set });
  }

  /** Delete telemetry older than ~13 months. Call occasionally. */
  async pruneTelemetry(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - 396 * 86400000);
    await this.db
      .delete(telemetry)
      .where(and(eq(telemetry.environmentId, this.environmentId), lt(telemetry.ts, cutoff)));
  }
}
