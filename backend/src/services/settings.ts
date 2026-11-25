import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

/** Half-hour-aligned local time, e.g. "08:00" or "21:30". */
const halfHourTime = z.string().regex(/^([01]\d|2[0-3]):(00|30)$/, "time must be HH:00 or HH:30");

export const tariffPeriodSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(40),
  start: halfHourTime,
  end: halfHourTime,
  price: z.number().min(0),
});

export type TariffPeriod = z.infer<typeof tariffPeriodSchema>;

/** A named set of price periods, e.g. a winter or a summer plan. */
export const tariffPlanSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(40),
  periods: z.array(tariffPeriodSchema).max(48),
});

export type TariffPlan = z.infer<typeof tariffPlanSchema>;

/** Id given to the plan created from pre-plans settings (a single `tariffPeriods` list). */
export const LEGACY_PLAN_ID = "plan-1";

export const appSettingsSchema = z.object({
  // System
  batteryCapacityKwh: z.number().min(0).max(1000).default(16),
  batteryMinSocPct: z.number().min(0).max(90).default(10),
  pvKwp: z.number().min(0).max(1000).default(5.5),
  tiltDeg: z.number().min(0).max(90).default(30),
  azimuthDeg: z.number().min(-180).max(180).default(0), // 0 = south
  performanceRatio: z.number().min(0.3).max(1).default(0.85),
  systemCost: z.number().min(0).default(0),
  installDate: z.string().nullable().default(null),
  co2KgPerKwh: z.number().min(0).max(2).default(0.35),
  /**
   * How often the inverter is polled, in seconds; null = the server default
   * (POLL_INTERVAL_MS, normally 5 s). Per environment: every installation can
   * run at its own pace. The poller re-reads this on every tick.
   */
  pollIntervalS: z.number().min(2).max(60).nullable().default(null),
  /**
   * Display units for the environment (shared by every member): "us" shows
   * °F / mph / inches in the UI and in server-generated alert texts. Values
   * are always stored metric — only formatting changes.
   */
  units: z.enum(["metric", "us"]).default("metric"),
  // Tariffs
  currency: z.string().default("EUR"),
  tariffMode: z.enum(["flat", "dayNight", "custom"]).default("flat"),
  importPrice: z.number().min(0).default(0.2),
  importPriceNight: z.number().min(0).default(0.12),
  exportPrice: z.number().min(0).default(0.05),
  nightStartHour: z.number().min(0).max(23).default(22),
  nightEndHour: z.number().min(0).max(23).default(7),
  /**
   * Custom tariff: named periods with their own import price (earlier wins on overlap).
   * Always mirrors the periods of the active plan (see `normalizeTariffPlans`); it is
   * what pricing reads, and what settings saved before plans existed contain.
   */
  tariffPeriods: z.array(tariffPeriodSchema).max(48).default([]),
  /** Custom tariff plans (e.g. winter / summer); `activeTariffPlanId` picks the one in use. */
  tariffPlans: z.array(tariffPlanSchema).max(12).default([]),
  activeTariffPlanId: z.string().max(40).nullable().default(null),
  // Generator
  generatorFuelLph: z.number().min(0).default(0),
  generatorOilChangeDate: z.string().nullable().default(null),
  generatorOilIntervalH: z.number().min(0).default(100),
  // Alert thresholds
  alertSocLowPct: z.number().min(0).max(100).default(20),
  alertTempHighC: z.number().min(0).max(150).default(75),
  alertGridVLow: z.number().min(0).default(195),
  alertGridVHigh: z.number().min(0).default(253),
  alertsEnabled: z.boolean().default(true),
  // MQTT / Home Assistant export
  mqttEnabled: z.boolean().default(false),
  mqttUrl: z.string().max(256).default(""),
  mqttUsername: z.string().max(128).default(""),
  mqttPassword: z.string().max(128).default(""),
  /** Empty means the default `helio/<environmentId>`. */
  mqttTopicPrefix: z.string().max(128).default(""),
  mqttHaDiscovery: z.boolean().default(true),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * Keeps plans and `tariffPeriods` consistent:
 *  - settings saved before plans existed (periods but no plans) become "Plan 1";
 *  - the active plan falls back to the first one if its id is missing or unknown;
 *  - `tariffPeriods` is set to the active plan's periods (empty with no plans).
 * Idempotent, so it is safe to run on every load and save.
 */
export function normalizeTariffPlans(s: AppSettings): AppSettings {
  const seen = new Set<string>();
  let plans = s.tariffPlans.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  if (plans.length === 0 && s.tariffPeriods.length > 0) {
    plans = [{ id: LEGACY_PLAN_ID, name: "Plan 1", periods: s.tariffPeriods }];
  }
  const active = plans.find((p) => p.id === s.activeTariffPlanId) ?? plans[0] ?? null;
  return {
    ...s,
    tariffPlans: plans,
    activeTariffPlanId: active?.id ?? null,
    tariffPeriods: active ? active.periods : [],
  };
}

/**
 * Clients that predate plans save the schedule as a bare `tariffPeriods` list.
 * Treat that as an edit of the active plan instead of silently dropping it.
 */
function plansWithLegacyEdit(current: AppSettings, periods: TariffPeriod[]): TariffPlan[] {
  if (current.tariffPlans.length === 0) {
    return [{ id: LEGACY_PLAN_ID, name: "Plan 1", periods }];
  }
  const activeId = current.activeTariffPlanId ?? current.tariffPlans[0].id;
  return current.tariffPlans.map((p) => (p.id === activeId ? { ...p, periods } : p));
}

export const DEFAULT_SETTINGS: AppSettings = normalizeTariffPlans(appSettingsSchema.parse({}));

const KEY = "app";

export class SettingsService {
  private cache: AppSettings = DEFAULT_SETTINGS;
  /** True once a settings row exists for this environment (saved at least once). */
  private persisted = false;

  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
  ) {}

  async load(): Promise<AppSettings> {
    const rows = await this.db
      .select()
      .from(settings)
      .where(and(eq(settings.environmentId, this.environmentId), eq(settings.key, KEY)));
    if (rows.length > 0) {
      this.persisted = true;
      const parsed = appSettingsSchema.safeParse(rows[0].value);
      // Older rows have no plans: normalizing turns their periods into "Plan 1".
      if (parsed.success) this.cache = normalizeTariffPlans(parsed.data);
    }
    return this.cache;
  }

  get(): AppSettings {
    return this.cache;
  }

  /** Whether the settings were ever saved (drives the first-run setup guide). */
  isPersisted(): boolean {
    return this.persisted;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...this.cache, ...patch };
    if (patch.tariffPeriods !== undefined && patch.tariffPlans === undefined) {
      next.tariffPlans = plansWithLegacyEdit(this.cache, patch.tariffPeriods);
    }
    const merged = normalizeTariffPlans(appSettingsSchema.parse(next));
    await this.db
      .insert(settings)
      .values({ environmentId: this.environmentId, key: KEY, value: merged })
      .onConflictDoUpdate({
        target: [settings.environmentId, settings.key],
        set: { value: merged },
      });
    this.cache = merged;
    this.persisted = true;
    return merged;
  }

  /** True when the given hour falls in the night tariff window. */
  isNightHour(hour: number): boolean {
    const { nightStartHour: start, nightEndHour: end } = this.cache;
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  }
}
