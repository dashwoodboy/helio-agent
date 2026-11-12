import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  dailyEnergy,
  dailyWeather,
  generatorSessions,
  notifications,
  outageEvents,
  telemetry,
} from "../db/schema.js";
import { localDateKey, localParts, zonedDayStart } from "../lib/time.js";
import { computeFlows } from "./flows.js";
import type { AppSettings } from "./settings.js";
import { SLOTS_PER_DAY, averageImportPrice, slotPeriodIndex, slotPrices } from "./tariff.js";

export type DailyRow = typeof dailyEnergy.$inferSelect;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface PeriodTotals {
  pvKwh: number;
  importKwh: number;
  exportKwh: number;
  loadKwh: number;
  battChargeKwh: number;
  battDischargeKwh: number;
  genKwh: number;
  selfSufficiencyPct: number | null;
  selfConsumptionPct: number | null;
  days: number;
}

export function totalsFor(rows: DailyRow[]): PeriodTotals {
  const sum = (f: (r: DailyRow) => number) => r1(rows.reduce((a, r) => a + f(r), 0));
  const pv = sum((r) => r.pvKwh);
  const load = sum((r) => r.loadKwh);
  const selfToLoad = sum((r) => r.pvToLoadKwh + r.battToLoadKwh);
  const selfUsedPv = sum((r) => r.pvToLoadKwh + r.pvToBattKwh);
  return {
    pvKwh: pv,
    importKwh: sum((r) => r.importKwh),
    exportKwh: sum((r) => r.exportKwh),
    loadKwh: load,
    battChargeKwh: sum((r) => r.battChargeKwh),
    battDischargeKwh: sum((r) => r.battDischargeKwh),
    genKwh: sum((r) => r.genKwh),
    selfSufficiencyPct: load > 0 ? Math.min(100, Math.round((selfToLoad / load) * 100)) : null,
    selfConsumptionPct: pv > 0 ? Math.min(100, Math.round((selfUsedPv / pv) * 100)) : null,
    days: rows.length,
  };
}

export function flowTotals(rows: DailyRow[]) {
  const sum = (f: (r: DailyRow) => number) => r2(rows.reduce((a, r) => a + f(r), 0));
  return {
    pvToLoadKwh: sum((r) => r.pvToLoadKwh),
    pvToBattKwh: sum((r) => r.pvToBattKwh),
    pvToGridKwh: sum((r) => r.pvToGridKwh),
    gridToLoadKwh: sum((r) => r.gridToLoadKwh),
    gridToBattKwh: sum((r) => r.gridToBattKwh),
    battToLoadKwh: sum((r) => r.battToLoadKwh),
    genToBattKwh: sum((r) => r.genToBattKwh),
    acPvToBattKwh: sum((r) => r.acPvToBattKwh),
  };
}

export class Analytics {
  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
    /** IANA timezone for day boundaries; process-local when omitted. */
    private readonly tz?: string,
  ) {}

  private get envFilter() {
    return eq(dailyEnergy.environmentId, this.environmentId);
  }

  async dailyRange(from: string, to: string): Promise<DailyRow[]> {
    return this.db
      .select()
      .from(dailyEnergy)
      .where(and(this.envFilter, gte(dailyEnergy.date, from), lte(dailyEnergy.date, to)))
      .orderBy(asc(dailyEnergy.date));
  }

  // -------------------------------------------------------------------- day

  async day(date: string) {
    const dayStart = zonedDayStart(date, this.tz);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const prevKey = localDateKey(new Date(dayStart.getTime() - 43200000), this.tz);

    const [series, dailyRows, prevRows, outages] = await Promise.all([
      this.db
        .select()
        .from(telemetry)
        .where(
          and(
            eq(telemetry.environmentId, this.environmentId),
            gte(telemetry.ts, dayStart),
            lte(telemetry.ts, dayEnd),
          ),
        )
        .orderBy(asc(telemetry.ts)),
      this.db
        .select()
        .from(dailyEnergy)
        .where(and(this.envFilter, sql`${dailyEnergy.date} = ${date}`)),
      this.db
        .select()
        .from(dailyEnergy)
        .where(and(this.envFilter, sql`${dailyEnergy.date} = ${prevKey}`)),
      this.db
        .select()
        .from(outageEvents)
        .where(
          and(
            eq(outageEvents.environmentId, this.environmentId),
            gte(outageEvents.startedAt, dayStart),
            lte(outageEvents.startedAt, dayEnd),
          ),
        ),
    ]);

    // Hourly kWh buckets from 1-min telemetry.
    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h, pvKwh: 0, loadKwh: 0, importKwh: 0, exportKwh: 0,
    }));
    for (const row of series) {
      const h = localParts(new Date(row.ts), this.tz).hour;
      const b = hourly[h];
      b.pvKwh += row.pvW / 60000;
      b.loadKwh += row.loadW / 60000;
      if (row.gridW > 0) b.importKwh += row.gridW / 60000;
      else b.exportKwh += -row.gridW / 60000;
    }
    for (const b of hourly) {
      b.pvKwh = r2(b.pvKwh); b.loadKwh = r2(b.loadKwh);
      b.importKwh = r2(b.importKwh); b.exportKwh = r2(b.exportKwh);
    }

    return {
      date,
      telemetry: series.map((row) => ({
        ts: row.ts.toISOString(),
        pvW: row.pvW,
        pv1W: row.pv1W,
        pv2W: row.pv2W,
        loadW: row.loadW,
        gridW: row.gridW,
        battW: row.battW,
        genW: row.genW,
        soc: row.soc,
        battV: row.battV,
        gridV: row.gridV,
        gridHz: row.gridHz,
      })),
      hourly,
      daily: dailyRows[0] ?? null,
      prevDaily: prevRows[0] ?? null,
      outages: outages.map((o) => ({
        startedAt: o.startedAt.toISOString(),
        endedAt: o.endedAt?.toISOString() ?? null,
      })),
      availableFrom: await this.firstDate(),
    };
  }

  // ------------------------------------------------------------------ month

  async month(ym: string) {
    const [y, m] = ym.split("-").map(Number);
    const first = `${ym}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const last = `${ym}-${String(lastDay).padStart(2, "0")}`;
    const prevYm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const prevLastDay = new Date(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 0).getDate();

    const [rows, prevRows] = await Promise.all([
      this.dailyRange(first, last),
      this.dailyRange(`${prevYm}-01`, `${prevYm}-${String(prevLastDay).padStart(2, "0")}`),
    ]);

    const best = rows.reduce<DailyRow | null>(
      (acc, row) => (acc === null || row.pvKwh > acc.pvKwh ? row : acc), null);
    const worst = rows.reduce<DailyRow | null>(
      (acc, row) => (acc === null || row.pvKwh < acc.pvKwh ? row : acc), null);

    return {
      month: ym,
      days: rows,
      totals: totalsFor(rows),
      flows: flowTotals(rows),
      prevTotals: totalsFor(prevRows),
      bestDay: best ? { date: best.date, pvKwh: best.pvKwh } : null,
      worstDay: worst ? { date: worst.date, pvKwh: worst.pvKwh } : null,
    };
  }

  // ------------------------------------------------------------------- year

  private async monthlyAggregates(year: number) {
    const rows = await this.db
      .select({
        month: sql<string>`to_char(${dailyEnergy.date}, 'YYYY-MM')`,
        pvKwh: sql<number>`round(sum(${dailyEnergy.pvKwh})::numeric, 1)`,
        importKwh: sql<number>`round(sum(${dailyEnergy.importKwh})::numeric, 1)`,
        exportKwh: sql<number>`round(sum(${dailyEnergy.exportKwh})::numeric, 1)`,
        loadKwh: sql<number>`round(sum(${dailyEnergy.loadKwh})::numeric, 1)`,
        selfToLoadKwh: sql<number>`round(sum(${dailyEnergy.pvToLoadKwh} + ${dailyEnergy.battToLoadKwh})::numeric, 1)`,
        days: sql<number>`count(*)`,
      })
      .from(dailyEnergy)
      .where(and(
        this.envFilter,
        gte(dailyEnergy.date, `${year}-01-01`),
        lte(dailyEnergy.date, `${year}-12-31`),
      ))
      .groupBy(sql`to_char(${dailyEnergy.date}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${dailyEnergy.date}, 'YYYY-MM')`);
    return rows.map((row) => ({
      ...row,
      pvKwh: Number(row.pvKwh), importKwh: Number(row.importKwh),
      exportKwh: Number(row.exportKwh), loadKwh: Number(row.loadKwh),
      selfToLoadKwh: Number(row.selfToLoadKwh), days: Number(row.days),
    }));
  }

  async year(year: number) {
    const [months, rows, prevRows] = await Promise.all([
      this.monthlyAggregates(year),
      this.dailyRange(`${year}-01-01`, `${year}-12-31`),
      this.dailyRange(`${year - 1}-01-01`, `${year - 1}-12-31`),
    ]);
    return {
      year,
      months,
      totals: totalsFor(rows),
      flows: flowTotals(rows),
      prevTotals: totalsFor(prevRows),
    };
  }

  // --------------------------------------------------------------- lifetime

  async firstDate(): Promise<string | null> {
    const rows = await this.db
      .select({ date: dailyEnergy.date })
      .from(dailyEnergy)
      .where(this.envFilter)
      .orderBy(asc(dailyEnergy.date))
      .limit(1);
    return rows[0]?.date ?? null;
  }

  async lifetime(settings: AppSettings) {
    const yearly = await this.db
      .select({
        year: sql<string>`to_char(${dailyEnergy.date}, 'YYYY')`,
        pvKwh: sql<number>`round(sum(${dailyEnergy.pvKwh})::numeric, 1)`,
        importKwh: sql<number>`round(sum(${dailyEnergy.importKwh})::numeric, 1)`,
        exportKwh: sql<number>`round(sum(${dailyEnergy.exportKwh})::numeric, 1)`,
        loadKwh: sql<number>`round(sum(${dailyEnergy.loadKwh})::numeric, 1)`,
        selfToLoadKwh: sql<number>`round(sum(${dailyEnergy.pvToLoadKwh} + ${dailyEnergy.battToLoadKwh})::numeric, 1)`,
      })
      .from(dailyEnergy)
      .where(this.envFilter)
      .groupBy(sql`to_char(${dailyEnergy.date}, 'YYYY')`)
      .orderBy(sql`to_char(${dailyEnergy.date}, 'YYYY')`);

    const allRows = await this.db.select().from(dailyEnergy).where(this.envFilter);
    const totals = totalsFor(allRows);
    const flows = flowTotals(allRows);

    const co2Kg = r1(totals.pvKwh * settings.co2KgPerKwh);
    const savings = computeSavings(allRows, settings);
    return {
      firstDate: await this.firstDate(),
      years: yearly.map((row) => ({
        year: Number(row.year),
        pvKwh: Number(row.pvKwh),
        importKwh: Number(row.importKwh),
        exportKwh: Number(row.exportKwh),
        loadKwh: Number(row.loadKwh),
        selfToLoadKwh: Number(row.selfToLoadKwh),
      })),
      totals,
      flows,
      co2Kg,
      treeEquivalent: Math.round(co2Kg / 21), // ~21 kg CO2/tree/year
      savings,
      paybackPct:
        settings.systemCost > 0
          ? Math.min(100, Math.round((savings.totalSaved / settings.systemCost) * 100))
          : null,
    };
  }

  // ---------------------------------------------------------------- battery

  async batteryStats(days: number, settings: AppSettings, currentSoc: number | null, currentLoadW: number | null) {
    const since = localDateKey(new Date(Date.now() - days * 86400000), this.tz);
    const rows = await this.dailyRange(since, localDateKey(new Date(), this.tz));
    const totalCharge = rows.reduce((a, r) => a + r.battChargeKwh, 0);
    const totalDischarge = rows.reduce((a, r) => a + r.battDischargeKwh, 0);
    const capacity = settings.batteryCapacityKwh;

    const usableKwh =
      currentSoc !== null
        ? Math.max(0, ((currentSoc - settings.batteryMinSocPct) / 100) * capacity)
        : null;
    const backupRuntimeMin =
      usableKwh !== null && currentLoadW && currentLoadW > 50
        ? Math.round((usableKwh * 1000 * 60) / currentLoadW)
        : null;

    const chargeSources = {
      pvKwh: r1(rows.reduce((a, r) => a + r.pvToBattKwh, 0)),
      acPvKwh: r1(rows.reduce((a, r) => a + r.acPvToBattKwh, 0)),
      genKwh: r1(rows.reduce((a, r) => a + r.genToBattKwh, 0)),
      gridKwh: r1(rows.reduce((a, r) => a + r.gridToBattKwh, 0)),
    };

    return {
      days,
      capacityKwh: capacity,
      totalChargeKwh: r1(totalCharge),
      totalDischargeKwh: r1(totalDischarge),
      chargeSources,
      cycles: capacity > 0 ? r1(totalDischarge / capacity) : 0,
      cyclesPerDay: capacity > 0 && rows.length > 0 ? r2(totalDischarge / capacity / rows.length) : 0,
      roundTripEfficiencyPct:
        totalCharge > 1 ? Math.min(100, Math.round((totalDischarge / totalCharge) * 100)) : null,
      usableKwhNow: usableKwh !== null ? r2(usableKwh) : null,
      backupRuntimeMin,
      daily: rows.map((r) => ({
        date: r.date,
        chargeKwh: r.battChargeKwh,
        dischargeKwh: r.battDischargeKwh,
        socMin: r.socMin,
        socMax: r.socMax,
        battVMin: r.battVMin,
        battVMax: r.battVMax,
      })),
    };
  }

  /** SOC + battery voltage series from telemetry (last N hours). */
  async batterySeries(hours: number) {
    const since = new Date(Date.now() - hours * 3600000);
    const rows = await this.db
      .select({ ts: telemetry.ts, soc: telemetry.soc, battV: telemetry.battV, battW: telemetry.battW })
      .from(telemetry)
      .where(and(eq(telemetry.environmentId, this.environmentId), gte(telemetry.ts, since)))
      .orderBy(asc(telemetry.ts));
    return rows.map((r) => ({
      ts: r.ts.toISOString(), soc: r.soc, battV: r.battV, battW: r.battW,
    }));
  }

  // ------------------------------------------------------------------- grid

  async gridQuality(hours: number) {
    const since = new Date(Date.now() - hours * 3600000);
    const rows = await this.db
      .select({
        ts: telemetry.ts,
        gridV: telemetry.gridV,
        gridHz: telemetry.gridHz,
        gridW: telemetry.gridW,
        l1V: telemetry.l1V,
        l2V: telemetry.l2V,
        l3V: telemetry.l3V,
      })
      .from(telemetry)
      .where(and(eq(telemetry.environmentId, this.environmentId), gte(telemetry.ts, since)))
      .orderBy(asc(telemetry.ts));
    const voltages = rows.map((r) => r.gridV).filter((v): v is number => v !== null && v > 50);
    // Per-phase min/max/avg on 3-phase systems (same >50V filter drops
    // outage samples). `phases` stays null on single-phase installs.
    const phaseStats = (pick: (r: (typeof rows)[number]) => number | null) => {
      const vs = rows.map(pick).filter((v): v is number => v !== null && v > 50);
      if (vs.length === 0) return null;
      return {
        minV: r1(Math.min(...vs)),
        maxV: r1(Math.max(...vs)),
        avgV: r1(vs.reduce((a, b) => a + b, 0) / vs.length),
      };
    };
    const l2 = phaseStats((r) => r.l2V);
    const l3 = phaseStats((r) => r.l3V);
    const phases =
      l2 && l3 ? { l1: phaseStats((r) => r.l1V ?? r.gridV), l2, l3 } : null;
    const stats =
      voltages.length > 0
        ? {
            minV: r1(Math.min(...voltages)),
            maxV: r1(Math.max(...voltages)),
            avgV: r1(voltages.reduce((a, b) => a + b, 0) / voltages.length),
            samples: voltages.length,
            phases,
          }
        : null;
    return {
      series: rows.map((r) => ({
        ts: r.ts.toISOString(), gridV: r.gridV, gridHz: r.gridHz, gridW: r.gridW,
        l1V: r.l1V, l2V: r.l2V, l3V: r.l3V,
      })),
      stats,
    };
  }

  async outages(days: number) {
    const since = new Date(Date.now() - days * 86400000);
    const events = await this.db
      .select()
      .from(outageEvents)
      .where(and(eq(outageEvents.environmentId, this.environmentId), gte(outageEvents.startedAt, since)))
      .orderBy(desc(outageEvents.startedAt));
    const closed = events.filter((e) => e.durationS !== null);
    const totalS = closed.reduce((a, e) => a + (e.durationS ?? 0), 0);
    const longest = closed.reduce((a, e) => Math.max(a, e.durationS ?? 0), 0);
    const socs = closed.map((e) => e.minSoc).filter((v): v is number => v !== null);
    return {
      days,
      events: events.map((e) => ({
        id: e.id,
        startedAt: e.startedAt.toISOString(),
        endedAt: e.endedAt?.toISOString() ?? null,
        durationS: e.durationS,
        minSoc: e.minSoc,
      })),
      stats: {
        count: events.length,
        totalHours: r1(totalS / 3600),
        longestHours: r1(longest / 3600),
        lowestSoc: socs.length > 0 ? Math.min(...socs) : null,
        avgPerWeek: r2(events.length / (days / 7)),
      },
    };
  }

  // -------------------------------------------------------------- generator

  async generator(days: number, settings: AppSettings, running: boolean, currentW: number) {
    const since = new Date(Date.now() - days * 86400000);
    const sessions = await this.db
      .select()
      .from(generatorSessions)
      .where(
        and(eq(generatorSessions.environmentId, this.environmentId), gte(generatorSessions.startedAt, since)),
      )
      .orderBy(desc(generatorSessions.startedAt));

    const todayKey = localDateKey(new Date(), this.tz);
    const monthKey = todayKey.slice(0, 7);
    let todayS = 0;
    let monthS = 0;
    let totalS = 0;
    let totalKwh = 0;
    for (const s of sessions) {
      const dur = s.runtimeS ??
        (s.endedAt ? 0 : Math.round((Date.now() - s.startedAt.getTime()) / 1000));
      totalS += dur;
      totalKwh += s.energyKwh;
      const key = localDateKey(s.startedAt, this.tz);
      if (key === todayKey) todayS += dur;
      if (key.startsWith(monthKey)) monthS += dur;
    }

    let oilHoursSince: number | null = null;
    if (settings.generatorOilChangeDate) {
      const oilDate = new Date(settings.generatorOilChangeDate);
      const oilSessions = await this.db
        .select()
        .from(generatorSessions)
        .where(
          and(eq(generatorSessions.environmentId, this.environmentId), gte(generatorSessions.startedAt, oilDate)),
        );
      oilHoursSince = r1(
        oilSessions.reduce((a, s) => a + (s.runtimeS ?? 0), 0) / 3600,
      );
    }

    const fuelRate = settings.generatorFuelLph;
    return {
      enabled: true,
      running,
      powerW: currentW,
      todayHours: r2(todayS / 3600),
      monthHours: r2(monthS / 3600),
      totalHours: r2(totalS / 3600),
      totalEnergyKwh: r1(totalKwh),
      fuelTodayL: fuelRate > 0 ? r2((todayS / 3600) * fuelRate) : null,
      fuelMonthL: fuelRate > 0 ? r2((monthS / 3600) * fuelRate) : null,
      oilChangeDate: settings.generatorOilChangeDate,
      oilHoursSince,
      oilIntervalH: settings.generatorOilIntervalH,
      sessions: sessions.slice(0, 50).map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        runtimeS: s.runtimeS,
        energyKwh: s.energyKwh,
        avgW: s.avgW,
      })),
    };
  }

  // ---------------------------------------------------------------- weather

  async weatherHistory(days: number) {
    const since = localDateKey(new Date(Date.now() - days * 86400000), this.tz);
    return this.db
      .select()
      .from(dailyWeather)
      .where(and(eq(dailyWeather.environmentId, this.environmentId), gte(dailyWeather.date, since)))
      .orderBy(asc(dailyWeather.date));
  }

  // ------------------------------------------------------------------ alerts

  async alerts(limit: number, unreadOnly: boolean) {
    const envEq = eq(notifications.environmentId, this.environmentId);
    const base = this.db.select().from(notifications);
    const rows = unreadOnly
      ? await base.where(and(envEq, sql`${notifications.read} = false`)).orderBy(desc(notifications.ts)).limit(limit)
      : await base.where(envEq).orderBy(desc(notifications.ts)).limit(limit);
    return rows.map((n) => ({
      id: n.id, ts: n.ts.toISOString(), rule: n.rule,
      severity: n.severity, title: n.title, body: n.body, read: n.read,
    }));
  }

  async markAlertsRead(ids: number[] | "all"): Promise<void> {
    const envEq = eq(notifications.environmentId, this.environmentId);
    if (ids === "all") {
      await this.db.update(notifications).set({ read: true }).where(envEq);
    } else if (ids.length > 0) {
      await this.db
        .update(notifications)
        .set({ read: true })
        .where(and(envEq, sql`${notifications.id} = ANY(${ids})`));
    }
  }

  async unreadCount(): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.environmentId, this.environmentId), sql`${notifications.read} = false`));
    return Number(rows[0]?.n ?? 0);
  }

  // --------------------------------------------------------- tariff backfill

  /**
   * Rebuild import_slots_kwh for past days from the 1-minute telemetry
   * (kept ~13 months). Each telemetry row is a 1-minute average, so a
   * positive gridW contributes gridW/60 Wh to its half-hour slot.
   * Days that already have slot data or have no telemetry are skipped.
   */
  async backfillImportSlots(): Promise<{ daysUpdated: number; daysSkipped: number }> {
    const today = localDateKey(new Date(), this.tz);
    const days = await this.db
      .select({ date: dailyEnergy.date, slots: dailyEnergy.importSlotsKwh })
      .from(dailyEnergy)
      .where(this.envFilter)
      .orderBy(asc(dailyEnergy.date));

    let daysUpdated = 0;
    let daysSkipped = 0;
    for (const day of days) {
      if (day.date === today) continue; // the recorder owns today
      const hasSlots = (day.slots?.reduce((a, b) => a + (b || 0), 0) ?? 0) > 0;
      if (hasSlots) {
        daysSkipped++;
        continue;
      }
      const dayStart = zonedDayStart(day.date, this.tz);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const rows = await this.db
        .select({ ts: telemetry.ts, gridW: telemetry.gridW })
        .from(telemetry)
        .where(
          and(
            eq(telemetry.environmentId, this.environmentId),
            gte(telemetry.ts, dayStart),
            lte(telemetry.ts, dayEnd),
          ),
        );
      if (rows.length === 0) {
        daysSkipped++;
        continue;
      }
      const slotsWh = new Array<number>(SLOTS_PER_DAY).fill(0);
      for (const row of rows) {
        if (row.gridW <= 0) continue;
        const p = localParts(new Date(row.ts), this.tz);
        const slot = p.hour * 2 + (p.minute >= 30 ? 1 : 0);
        slotsWh[slot] += row.gridW / 60;
      }
      await this.db
        .update(dailyEnergy)
        .set({ importSlotsKwh: slotsWh.map((wh) => Math.round(wh) / 1000) })
        .where(and(this.envFilter, sql`${dailyEnergy.date} = ${day.date}`));
      daysUpdated++;
    }
    return { daysUpdated, daysSkipped };
  }

  // --------------------------------------------------- AC-coupling backfill

  /**
   * Recompute ac_pv_to_batt_kwh for past days from the 1-minute telemetry,
   * using the residual-based attribution in computeFlows. Each row is a
   * 1-minute average, so its acPvToBattW contributes acPvToBattW/60 Wh.
   * Today is skipped (the recorder owns it), as are days without telemetry.
   * Idempotent: rerunning just rewrites the same values.
   */
  async backfillAcCoupling(): Promise<{ daysUpdated: number; daysSkipped: number }> {
    const today = localDateKey(new Date(), this.tz);
    const days = await this.db
      .select({ date: dailyEnergy.date })
      .from(dailyEnergy)
      .where(this.envFilter)
      .orderBy(asc(dailyEnergy.date));

    let daysUpdated = 0;
    let daysSkipped = 0;
    for (const day of days) {
      if (day.date === today) continue; // the recorder owns today
      const dayStart = zonedDayStart(day.date, this.tz);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const rows = await this.db
        .select({
          pvW: telemetry.pvW,
          loadW: telemetry.loadW,
          gridW: telemetry.gridW,
          battW: telemetry.battW,
          genW: telemetry.genW,
        })
        .from(telemetry)
        .where(
          and(
            eq(telemetry.environmentId, this.environmentId),
            gte(telemetry.ts, dayStart),
            lte(telemetry.ts, dayEnd),
          ),
        );
      if (rows.length === 0) {
        daysSkipped++;
        continue;
      }
      let acWh = 0;
      for (const row of rows) acWh += computeFlows(row).acPvToBattW / 60;
      await this.db
        .update(dailyEnergy)
        .set({ acPvToBattKwh: Math.round(acWh) / 1000 })
        .where(and(this.envFilter, sql`${dailyEnergy.date} = ${day.date}`));
      daysUpdated++;
    }
    return { daysUpdated, daysSkipped };
  }
}

// -------------------------------------------------------------------- savings

export interface SavingsBreakdown {
  selfConsumedKwh: number;
  avoidedImportCost: number;
  exportRevenue: number;
  importCost: number;
  totalSaved: number;
  currency: string;
  /** Per-period import split; present only in custom tariff mode. */
  importByPeriod?: { name: string; kwh: number; cost: number }[];
}

export function computeSavings(rows: DailyRow[], s: AppSettings): SavingsBreakdown {
  if (s.tariffMode === "custom") return computeCustomSavings(rows, s);
  let avoided = 0;
  let exportRev = 0;
  let importCost = 0;
  let selfConsumed = 0;
  for (const r of rows) {
    const self = r.pvToLoadKwh + r.battToLoadKwh;
    selfConsumed += self;
    // Self-consumed energy displaces daytime-priced imports.
    avoided += self * s.importPrice;
    exportRev += r.exportKwh * s.exportPrice;
    if (s.tariffMode === "dayNight" && (r.importDayKwh > 0 || r.importNightKwh > 0)) {
      importCost += r.importDayKwh * s.importPrice + r.importNightKwh * s.importPriceNight;
    } else {
      importCost += r.importKwh * s.importPrice;
    }
  }
  return {
    selfConsumedKwh: r1(selfConsumed),
    avoidedImportCost: r2(avoided),
    exportRevenue: r2(exportRev),
    importCost: r2(importCost),
    totalSaved: r2(avoided + exportRev),
    currency: s.currency,
  };
}

/**
 * Custom tariff: price each day's import by its half-hour slot distribution.
 * The day's importKwh total stays authoritative (inverter counters); slots
 * only distribute it. Days without slot data fall back to spreading the
 * import across the day's slots evenly (time-weighted average price).
 */
function computeCustomSavings(rows: DailyRow[], s: AppSettings): SavingsBreakdown {
  const prices = slotPrices(s);
  const periodOfSlot = slotPeriodIndex(s.tariffPeriods);
  const avgPrice = averageImportPrice(s);

  // kWh/cost buckets: one per period, plus index -1 for the default price.
  const periodKwh = new Map<number, number>();
  const periodCost = new Map<number, number>();
  const bump = (idx: number, kwh: number, cost: number) => {
    periodKwh.set(idx, (periodKwh.get(idx) ?? 0) + kwh);
    periodCost.set(idx, (periodCost.get(idx) ?? 0) + cost);
  };

  let avoided = 0;
  let exportRev = 0;
  let importCost = 0;
  let selfConsumed = 0;
  for (const r of rows) {
    const self = r.pvToLoadKwh + r.battToLoadKwh;
    selfConsumed += self;
    avoided += self * avgPrice;
    exportRev += r.exportKwh * s.exportPrice;

    const slots = r.importSlotsKwh;
    const slotSum = slots?.reduce((a, b) => a + (b || 0), 0) ?? 0;
    if (slots && slotSum > 0.001 && r.importKwh > 0) {
      const scale = r.importKwh / slotSum;
      for (let i = 0; i < Math.min(slots.length, SLOTS_PER_DAY); i++) {
        const kwh = (slots[i] || 0) * scale;
        if (kwh <= 0) continue;
        const cost = kwh * prices[i];
        importCost += cost;
        bump(periodOfSlot[i], kwh, cost);
      }
    } else if (r.importKwh > 0) {
      // No slot data: spread the import evenly across the day.
      const kwhPerSlot = r.importKwh / SLOTS_PER_DAY;
      for (let i = 0; i < SLOTS_PER_DAY; i++) {
        const cost = kwhPerSlot * prices[i];
        importCost += cost;
        bump(periodOfSlot[i], kwhPerSlot, cost);
      }
    }
  }

  const importByPeriod = [
    ...s.tariffPeriods.map((p, idx) => ({
      name: p.name,
      kwh: r1(periodKwh.get(idx) ?? 0),
      cost: r2(periodCost.get(idx) ?? 0),
    })),
    ...(periodOfSlot.includes(-1)
      ? [{ name: "Other times", kwh: r1(periodKwh.get(-1) ?? 0), cost: r2(periodCost.get(-1) ?? 0) }]
      : []),
  ];

  return {
    selfConsumedKwh: r1(selfConsumed),
    avoidedImportCost: r2(avoided),
    exportRevenue: r2(exportRev),
    importCost: r2(importCost),
    totalSaved: r2(avoided + exportRev),
    currency: s.currency,
    importByPeriod,
  };
}
