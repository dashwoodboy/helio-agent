import { describe, expect, it } from "vitest";
import {
  SLOTS_PER_DAY,
  averageImportPrice,
  slotOf,
  slotPeriodIndex,
  slotPrices,
  timeToSlot,
} from "../src/services/tariff.js";
import { computeSavings, type DailyRow } from "../src/services/analytics.js";
import { DEFAULT_SETTINGS, type AppSettings, type TariffPeriod } from "../src/services/settings.js";

const p = (name: string, start: string, end: string, price: number): TariffPeriod => ({
  id: name, name, start, end, price,
});

describe("tariff slots", () => {
  it("maps times and dates to slots", () => {
    expect(timeToSlot("00:00")).toBe(0);
    expect(timeToSlot("00:30")).toBe(1);
    expect(timeToSlot("13:00")).toBe(26);
    expect(timeToSlot("23:30")).toBe(47);
    expect(slotOf(new Date("2026-01-01T08:35:00"))).toBe(17);
  });

  it("assigns slots to periods, default elsewhere", () => {
    const idx = slotPeriodIndex([p("peak", "08:00", "20:00", 0.3)]);
    expect(idx[timeToSlot("08:00")]).toBe(0);
    expect(idx[timeToSlot("19:30")]).toBe(0);
    expect(idx[timeToSlot("20:00")]).toBe(-1);
    expect(idx[timeToSlot("07:30")]).toBe(-1);
  });

  it("wraps periods past midnight", () => {
    const idx = slotPeriodIndex([p("night", "22:00", "07:00", 0.1)]);
    expect(idx[timeToSlot("23:30")]).toBe(0);
    expect(idx[timeToSlot("00:00")]).toBe(0);
    expect(idx[timeToSlot("06:30")]).toBe(0);
    expect(idx[timeToSlot("07:00")]).toBe(-1);
    expect(idx[timeToSlot("21:30")]).toBe(-1);
  });

  it("earlier period wins overlaps; start === end is empty", () => {
    const idx = slotPeriodIndex([
      p("first", "08:00", "12:00", 0.3),
      p("second", "10:00", "14:00", 0.2),
      p("empty", "15:00", "15:00", 9),
    ]);
    expect(idx[timeToSlot("11:00")]).toBe(0); // overlap -> first
    expect(idx[timeToSlot("12:00")]).toBe(1);
    expect(idx[timeToSlot("15:00")]).toBe(-1); // empty period claims nothing
  });

  it("prices and average fall back to the default price", () => {
    const s = { importPrice: 0.2, tariffPeriods: [p("half", "00:00", "12:00", 0.4)] };
    const prices = slotPrices(s);
    expect(prices).toHaveLength(SLOTS_PER_DAY);
    expect(prices[0]).toBe(0.4);
    expect(prices[47]).toBe(0.2);
    expect(averageImportPrice(s)).toBeCloseTo(0.3, 10);
  });
});

describe("computeSavings in custom mode", () => {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    tariffMode: "custom",
    importPrice: 0.1, // default outside periods
    exportPrice: 0.05,
    tariffPeriods: [p("peak", "18:00", "22:00", 0.5)],
  };

  const baseRow: Partial<DailyRow> = {
    pvKwh: 10, exportKwh: 2, loadKwh: 12,
    pvToLoadKwh: 6, battToLoadKwh: 2,
  };

  it("prices import by slot distribution when slots exist", () => {
    // 4 kWh imported: 3 kWh inside peak (18:00 slot 36), 1 kWh outside (slot 0).
    const slots = new Array(48).fill(0);
    slots[36] = 3;
    slots[0] = 1;
    const row = { ...baseRow, importKwh: 4, importSlotsKwh: slots } as DailyRow;
    const result = computeSavings([row], settings);
    expect(result.importCost).toBeCloseTo(3 * 0.5 + 1 * 0.1, 5);
    const peak = result.importByPeriod!.find((x) => x.name === "peak")!;
    const other = result.importByPeriod!.find((x) => x.name === "Other times")!;
    expect(peak.kwh).toBeCloseTo(3, 1);
    expect(peak.cost).toBeCloseTo(1.5, 2);
    expect(other.kwh).toBeCloseTo(1, 1);
  });

  it("rescales slots to the authoritative daily import total", () => {
    const slots = new Array(48).fill(0);
    slots[36] = 1; // slots only recorded half of the day's import
    const row = { ...baseRow, importKwh: 2, importSlotsKwh: slots } as DailyRow;
    const result = computeSavings([row], settings);
    expect(result.importCost).toBeCloseTo(2 * 0.5, 5);
  });

  it("falls back to an even spread without slot data", () => {
    const row = { ...baseRow, importKwh: 4.8, importSlotsKwh: null } as DailyRow;
    const result = computeSavings([row], settings);
    // 8 of 48 slots are peak: avg price = (8*0.5 + 40*0.1)/48 = 0.1667
    expect(result.importCost).toBeCloseTo(4.8 * (8 * 0.5 + 40 * 0.1) / 48, 5);
  });

  it("values self-consumption at the time-weighted average price", () => {
    const row = { ...baseRow, importKwh: 0, importSlotsKwh: null } as DailyRow;
    const result = computeSavings([row], settings);
    const avg = (8 * 0.5 + 40 * 0.1) / 48;
    expect(result.avoidedImportCost).toBeCloseTo(8 * avg, 2);
    expect(result.exportRevenue).toBeCloseTo(2 * 0.05, 5);
    expect(result.totalSaved).toBeCloseTo(8 * avg + 0.1, 2);
  });
});
