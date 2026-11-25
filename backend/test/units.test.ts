import { describe, expect, it } from "vitest";
import { cToF, fToC, fmtRain, fmtTemp, fmtWind, kmhToMph, mmToIn } from "../src/lib/units.js";

describe("unit conversions", () => {
  it("converts temperatures both ways", () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(fToC(212)).toBe(100);
    expect(fToC(cToF(37.5))).toBeCloseTo(37.5, 10);
  });

  it("converts wind and rain", () => {
    expect(kmhToMph(1.609344)).toBeCloseTo(1, 10);
    expect(mmToIn(25.4)).toBeCloseTo(1, 10);
  });
});

describe("unit formatting (alert texts)", () => {
  it("formats temperatures per unit system", () => {
    // Same strings the tempHigh alert produces.
    expect(fmtTemp(85.2, "metric")).toBe("85.2°C");
    expect(fmtTemp(85.2, "us")).toBe("185.4°F");
    expect(fmtTemp(75, "metric", 0)).toBe("75°C");
    expect(fmtTemp(75, "us", 0)).toBe("167°F");
  });

  it("formats wind and rain per unit system", () => {
    expect(fmtWind(80, "metric")).toBe("80 km/h");
    expect(fmtWind(80, "us")).toBe("50 mph");
    expect(fmtRain(50.8, "metric")).toBe("51 mm");
    expect(fmtRain(50.8, "us")).toBe("2.0 in");
  });
});
