import { describe, expect, it } from "vitest";
import { computeWarnings, type DailyForecast } from "../src/services/weather.js";
import { localDateKey } from "../src/lib/time.js";

function day(offsetDays: number, overrides: Partial<DailyForecast> = {}): DailyForecast {
  return {
    date: localDateKey(new Date(Date.now() + offsetDays * 86400000)),
    weatherCode: 1,
    tempMax: 20,
    tempMin: 10,
    precipMm: 0,
    windGustsKmh: 20,
    sunrise: "07:00",
    sunset: "18:00",
    radiationKwhM2: 5,
    ...overrides,
  };
}

describe("computeWarnings", () => {
  it("returns nothing for a calm week", () => {
    const daily = [0, 1, 2, 3, 4, 5, 6].map((i) => day(i));
    expect(computeWarnings(daily)).toEqual([]);
  });

  it("warns on strong wind and escalates to critical", () => {
    const warnings = computeWarnings([day(0, { windGustsKmh: 75 }), day(1, { windGustsKmh: 95 })]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({ kind: "wind", severity: "warn" });
    expect(warnings[0].title).toBe("Strong wind today");
    expect(warnings[0].text).toContain("75 km/h");
    expect(warnings[1]).toMatchObject({ kind: "wind", severity: "critical" });
    expect(warnings[1].title).toBe("Strong wind tomorrow");
  });

  it("stays quiet just below the wind threshold", () => {
    expect(computeWarnings([day(0, { windGustsKmh: 69 })])).toEqual([]);
  });

  it("warns on heavy rain and escalates to critical", () => {
    const warnings = computeWarnings([day(0, { precipMm: 35 }), day(1, { precipMm: 60 })]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({ kind: "rain", severity: "warn" });
    expect(warnings[1]).toMatchObject({ kind: "rain", severity: "critical" });
    expect(warnings[1].text).toContain("60 mm");
  });

  it("flags thunderstorms, hail as critical", () => {
    const warnings = computeWarnings([day(0, { weatherCode: 95 }), day(1, { weatherCode: 96 })]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({ kind: "storm", severity: "warn" });
    expect(warnings[1]).toMatchObject({ kind: "storm", severity: "critical" });
  });

  it("flags snow as warn and freezing rain as critical", () => {
    const warnings = computeWarnings([day(0, { weatherCode: 73 }), day(1, { weatherCode: 66 })]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({ kind: "snow", severity: "warn" });
    expect(warnings[0].title).toBe("Snow today");
    expect(warnings[1]).toMatchObject({ kind: "snow", severity: "critical" });
    expect(warnings[1].title).toBe("Freezing rain tomorrow");
  });

  it("emits multiple warnings for one bad day and names later weekdays", () => {
    const warnings = computeWarnings([day(3, { windGustsKmh: 92, precipMm: 55, weatherCode: 95 })]);
    expect(warnings.map((w) => w.kind).sort()).toEqual(["rain", "storm", "wind"]);
    for (const w of warnings) expect(w.title).toMatch(/on (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/);
  });

  it("skips days in the past", () => {
    expect(computeWarnings([day(-1, { windGustsKmh: 120 })])).toEqual([]);
  });

  it("tolerates missing fields", () => {
    expect(computeWarnings([day(0, { windGustsKmh: null, precipMm: null, weatherCode: null })])).toEqual([]);
  });
});
