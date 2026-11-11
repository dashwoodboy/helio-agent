import { describe, expect, it } from "vitest";
import { estimateChargeTime, PowerWindow } from "../src/services/chargeEta.js";

describe("estimateChargeTime", () => {
  const now = new Date("2026-06-01T10:00:00");

  it("reports full at 100%", () => {
    expect(estimateChargeTime(100, 0, 16, 10, now).status).toBe("full");
  });

  it("estimates time to full while charging", () => {
    // 50% of 16 kWh = 8 kWh at 4000 W -> 2 h
    const est = estimateChargeTime(50, 4000, 16, 10, now);
    expect(est.status).toBe("charging");
    expect(est.minutes).toBe(120);
    expect(est.etaClock).toBe("12:00");
    expect(est.remainingKwh).toBe(8);
  });

  it("applies the 1.5x taper above 90%", () => {
    // 10% of 16 kWh = 1.6 kWh at 1600 W = 1h * 1.5 = 90 min
    const est = estimateChargeTime(90, 1600, 16, 10, now);
    expect(est.minutes).toBe(90);
  });

  it("estimates time to empty while discharging", () => {
    // Usable 50-10 = 40% of 16 kWh = 6.4 kWh at 800 W -> 480 min
    const est = estimateChargeTime(50, -800, 16, 10, now);
    expect(est.status).toBe("discharging");
    expect(est.minutes).toBe(480);
  });

  it("is idle for trickle power", () => {
    expect(estimateChargeTime(50, 20, 16, 10, now).status).toBe("idle");
    expect(estimateChargeTime(50, -30, 16, 10, now).status).toBe("idle");
  });
});

describe("PowerWindow", () => {
  it("averages samples", () => {
    const w = new PowerWindow(4);
    [1000, 2000, 3000].forEach((p) => w.add(p));
    expect(w.average()).toBe(2000);
  });

  it("resets when the direction flips", () => {
    const w = new PowerWindow(10);
    [2000, 2200].forEach((p) => w.add(p));
    w.add(-500);
    expect(w.average()).toBe(-500);
  });
});
