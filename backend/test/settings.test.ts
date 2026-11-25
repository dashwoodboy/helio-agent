import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { computeSavings, type DailyRow } from "../src/services/analytics.js";
import {
  DEFAULT_SETTINGS,
  LEGACY_PLAN_ID,
  SettingsService,
  appSettingsSchema,
  normalizeTariffPlans,
  type TariffPeriod,
  type TariffPlan,
} from "../src/services/settings.js";

const period = (id: string, start: string, end: string, price: number): TariffPeriod => ({
  id, name: id, start, end, price,
});
const plan = (id: string, periods: TariffPeriod[]): TariffPlan => ({ id, name: id, periods });

const WINTER = plan("winter", [period("peak", "18:00", "22:00", 0.5)]);
const SUMMER = plan("summer", [period("peak", "18:00", "22:00", 0.2)]);

describe("normalizeTariffPlans", () => {
  it("turns settings saved before plans existed into 'Plan 1'", () => {
    // Exactly what an old settings row contains: periods, no plans.
    const legacy = appSettingsSchema.parse({
      tariffMode: "custom",
      tariffPeriods: [period("peak", "18:00", "22:00", 0.5)],
    });
    expect(legacy.tariffPlans).toEqual([]);

    const s = normalizeTariffPlans(legacy);
    expect(s.tariffPlans).toHaveLength(1);
    expect(s.tariffPlans[0]).toMatchObject({ id: LEGACY_PLAN_ID, name: "Plan 1" });
    expect(s.activeTariffPlanId).toBe(LEGACY_PLAN_ID);
    // Pricing still reads the same periods as before.
    expect(s.tariffPeriods).toEqual(legacy.tariffPeriods);
  });

  it("leaves a settings object with no tariff at all untouched", () => {
    expect(DEFAULT_SETTINGS.tariffPlans).toEqual([]);
    expect(DEFAULT_SETTINGS.activeTariffPlanId).toBeNull();
    expect(DEFAULT_SETTINGS.tariffPeriods).toEqual([]);
  });

  it("mirrors the active plan into tariffPeriods", () => {
    const s = normalizeTariffPlans(
      appSettingsSchema.parse({ tariffPlans: [WINTER, SUMMER], activeTariffPlanId: "summer" }),
    );
    expect(s.activeTariffPlanId).toBe("summer");
    expect(s.tariffPeriods).toEqual(SUMMER.periods);
  });

  it("falls back to the first plan when the active id is missing or unknown", () => {
    for (const activeTariffPlanId of [null, "gone"]) {
      const s = normalizeTariffPlans(
        appSettingsSchema.parse({ tariffPlans: [WINTER, SUMMER], activeTariffPlanId }),
      );
      expect(s.activeTariffPlanId).toBe("winter");
      expect(s.tariffPeriods).toEqual(WINTER.periods);
    }
  });

  it("drops duplicate plan ids and is idempotent", () => {
    const once = normalizeTariffPlans(
      appSettingsSchema.parse({ tariffPlans: [WINTER, WINTER, SUMMER], activeTariffPlanId: "winter" }),
    );
    expect(once.tariffPlans.map((p) => p.id)).toEqual(["winter", "summer"]);
    expect(normalizeTariffPlans(once)).toEqual(once);
  });
});

describe("pricing follows the active plan", () => {
  const row = {
    pvKwh: 0, exportKwh: 0, loadKwh: 4, pvToLoadKwh: 0, battToLoadKwh: 0,
    importKwh: 4,
    // All 4 kWh imported inside the 18:00-22:00 window (slot 36).
    importSlotsKwh: Object.assign(new Array(48).fill(0), { 36: 4 }),
  } as unknown as DailyRow;

  const settingsFor = (activeTariffPlanId: string) =>
    normalizeTariffPlans(
      appSettingsSchema.parse({
        tariffMode: "custom",
        importPrice: 0.1,
        tariffPlans: [WINTER, SUMMER],
        activeTariffPlanId,
      }),
    );

  it("prices the same day differently per plan", () => {
    expect(computeSavings([row], settingsFor("winter")).importCost).toBeCloseTo(4 * 0.5, 5);
    expect(computeSavings([row], settingsFor("summer")).importCost).toBeCloseTo(4 * 0.2, 5);
  });
});

/** Minimal stand-in for the drizzle chain SettingsService uses. */
function fakeDb(stored: unknown): { db: Db; saved: () => unknown } {
  let saved: unknown = null;
  const db = {
    select: () => ({ from: () => ({ where: async () => (stored ? [{ value: stored }] : []) }) }),
    insert: () => ({
      values: (row: { value: unknown }) => ({
        onConflictDoUpdate: async () => {
          saved = row.value;
        },
      }),
    }),
  } as unknown as Db;
  return { db, saved: () => saved };
}

describe("SettingsService", () => {
  it("loads an existing row from before plans without losing its periods", async () => {
    const { db } = fakeDb({ tariffMode: "custom", tariffPeriods: [period("peak", "18:00", "22:00", 0.5)] });
    const svc = new SettingsService(db, "env");
    const s = await svc.load();
    expect(s.tariffMode).toBe("custom");
    expect(s.tariffPlans.map((p) => p.name)).toEqual(["Plan 1"]);
    expect(s.tariffPeriods).toHaveLength(1);
    expect(s.tariffPeriods[0].price).toBe(0.5);
  });

  it("a client that predates plans (sends only tariffPeriods) edits the active plan", async () => {
    const { db, saved } = fakeDb({ tariffPlans: [WINTER, SUMMER], activeTariffPlanId: "summer" });
    const svc = new SettingsService(db, "env");
    await svc.load();

    const edited = [period("peak", "17:00", "21:00", 0.33)];
    const s = await svc.update({ tariffPeriods: edited });

    expect(s.activeTariffPlanId).toBe("summer");
    expect(s.tariffPlans.find((p) => p.id === "summer")!.periods).toEqual(edited);
    expect(s.tariffPlans.find((p) => p.id === "winter")!.periods).toEqual(WINTER.periods); // untouched
    expect(s.tariffPeriods).toEqual(edited);
    expect((saved() as { tariffPlans: unknown[] }).tariffPlans).toHaveLength(2);
  });

  it("a legacy client saving periods with no plans yet creates 'Plan 1'", async () => {
    const { db } = fakeDb(null);
    const svc = new SettingsService(db, "env");
    await svc.load();
    const s = await svc.update({ tariffPeriods: [period("peak", "18:00", "22:00", 0.4)] });
    expect(s.tariffPlans).toHaveLength(1);
    expect(s.activeTariffPlanId).toBe(s.tariffPlans[0].id);
  });

  it("switching the active plan swaps the periods and keeps every plan", async () => {
    const { db } = fakeDb({ tariffPlans: [WINTER, SUMMER], activeTariffPlanId: "winter" });
    const svc = new SettingsService(db, "env");
    await svc.load();
    const s = await svc.update({ activeTariffPlanId: "summer" });
    expect(s.activeTariffPlanId).toBe("summer");
    expect(s.tariffPeriods).toEqual(SUMMER.periods);
    expect(s.tariffPlans).toHaveLength(2);
  });

  it("a new client sending plans and periods together stays consistent", async () => {
    const { db } = fakeDb(null);
    const svc = new SettingsService(db, "env");
    await svc.load();
    const s = await svc.update({
      tariffPlans: [WINTER, SUMMER],
      activeTariffPlanId: "winter",
      tariffPeriods: SUMMER.periods, // stale mirror; the active plan wins
    });
    expect(s.tariffPeriods).toEqual(WINTER.periods);
  });
});

describe("units setting", () => {
  it("defaults to metric — existing rows without the field stay metric", () => {
    expect(DEFAULT_SETTINGS.units).toBe("metric");
    expect(appSettingsSchema.parse({ currency: "USD" }).units).toBe("metric");
  });

  it("accepts us and rejects anything else", async () => {
    const { db, saved } = fakeDb(null);
    const svc = new SettingsService(db, "env");
    await svc.load();
    const s = await svc.update({ units: "us" });
    expect(s.units).toBe("us");
    expect((saved() as { units: string }).units).toBe("us");
    expect(() => appSettingsSchema.parse({ units: "imperial" })).toThrow();
  });
});
