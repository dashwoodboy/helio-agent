import { describe, expect, it } from "vitest";
import { AlertDeduper, DAY_DEDUPED_RULES, stormSignature } from "../src/services/alertDedupe.js";
import type { WeatherWarning } from "../src/services/weather.js";

function warning(over: Partial<WeatherWarning> = {}): WeatherWarning {
  return {
    date: "2026-11-12",
    kind: "wind",
    severity: "warn",
    title: "Strong wind today",
    text: "Gusts up to 75 km/h.",
    ...over,
  };
}

describe("transition (edge trigger)", () => {
  it("fires only when the condition becomes true", () => {
    const d = new AlertDeduper();
    expect(d.transition("socLow", false)).toBe(false);
    expect(d.transition("socLow", true)).toBe(true); // enter
    expect(d.transition("socLow", true)).toBe(false); // still in
    expect(d.transition("socLow", false)).toBe(false); // recover
    expect(d.transition("socLow", true)).toBe(true); // re-enter re-arms
  });

  it("tracks rules independently", () => {
    const d = new AlertDeduper();
    expect(d.transition("tempHigh", true)).toBe(true);
    expect(d.transition("socLow", true)).toBe(true);
  });
});

describe("day dedupe", () => {
  it("allows one emission per rule per day, re-allows the next day", () => {
    const d = new AlertDeduper();
    expect(d.shouldFire("socLow", "2026-11-12")).toBe(true);
    d.markFired("socLow", "2026-11-12");
    expect(d.shouldFire("socLow", "2026-11-12")).toBe(false);
    expect(d.shouldFire("socLow", "2026-11-13")).toBe(true);
  });

  it("different signatures on the same day are separate alerts", () => {
    const d = new AlertDeduper();
    d.markFired("stormWarning", "2026-11-12", "wind|warn|2026-11-12");
    expect(d.shouldFire("stormWarning", "2026-11-12", "wind|warn|2026-11-12")).toBe(false);
    // Escalation warn → critical must still get through the same day.
    expect(d.shouldFire("stormWarning", "2026-11-12", "wind|critical|2026-11-12")).toBe(true);
  });

  it("classifies the storm and threshold rules as day-deduped, not the event rules", () => {
    for (const rule of ["socLow", "stormWarning", "stormCleared", "inverterOffline"]) {
      expect(DAY_DEDUPED_RULES.has(rule), rule).toBe(true);
    }
    for (const rule of ["gridLost", "gridRestored", "generatorStarted", "generatorStopped"]) {
      expect(DAY_DEDUPED_RULES.has(rule), rule).toBe(false);
    }
  });
});

describe("updateSignature", () => {
  it("fires on a new warning, stays quiet while it is unchanged", () => {
    const d = new AlertDeduper();
    expect(d.updateSignature("stormWarning", "wind|warn|2026-11-12")).toEqual({
      changed: true,
      cleared: false,
    });
    expect(d.updateSignature("stormWarning", "wind|warn|2026-11-12")).toEqual({
      changed: false,
      cleared: false,
    });
  });

  it("fires again when the warning escalates or moves to another day", () => {
    const d = new AlertDeduper();
    d.updateSignature("stormWarning", "wind|warn|2026-11-12");
    expect(d.updateSignature("stormWarning", "wind|critical|2026-11-12").changed).toBe(true);
    expect(d.updateSignature("stormWarning", "wind|critical|2026-11-13").changed).toBe(true);
  });

  it("notices a known warning clearing (wind 75 km/h → none)", () => {
    const d = new AlertDeduper();
    d.updateSignature("stormWarning", "wind|warn|2026-11-12");
    expect(d.updateSignature("stormWarning", null)).toEqual({ changed: false, cleared: true });
    // Already clear: no repeat all-clear.
    expect(d.updateSignature("stormWarning", null)).toEqual({ changed: false, cleared: false });
  });

  it("never announces a phantom all-clear after a restart", () => {
    const d = new AlertDeduper(); // fresh process, no seeded signature
    expect(d.updateSignature("stormWarning", null).cleared).toBe(false);
  });

  it("a seeded signature survives into clear detection", () => {
    const d = new AlertDeduper();
    d.seedSignature("stormWarning", "wind|warn|2026-11-12"); // from today's notifications
    expect(d.updateSignature("stormWarning", null).cleared).toBe(true);
  });
});

describe("stormSignature", () => {
  it("is null without warnings in the window", () => {
    expect(stormSignature([], "2026-11-12", "2026-11-13").signature).toBeNull();
    const far = warning({ date: "2026-11-20" });
    expect(stormSignature([far], "2026-11-12", "2026-11-13").signature).toBeNull();
  });

  it("picks the most severe warning, earliest first on ties", () => {
    const warnings = [
      warning({ date: "2026-11-13", severity: "warn", kind: "rain" }),
      warning({ date: "2026-11-13", severity: "critical", kind: "wind" }),
      warning({ date: "2026-11-12", severity: "critical", kind: "storm" }),
    ];
    const { signature, worst } = stormSignature(warnings, "2026-11-12", "2026-11-13");
    expect(signature).toBe("storm|critical|2026-11-12");
    expect(worst?.kind).toBe("storm");
  });
});
