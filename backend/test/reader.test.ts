import { describe, expect, it } from "vitest";
import { DeyeInverter } from "../src/inverter/reader.js";
import type { InverterConfig } from "../src/inverter/types.js";
import type { RegisterTransport } from "../src/solarman/transport.js";

/** Register-map-backed fake: unset registers read as 0. */
function fakeTransport(regs: Record<number, number>): RegisterTransport {
  return {
    async connect() {},
    async disconnect() {},
    async readHoldingRegisters(start, quantity) {
      return Array.from({ length: quantity }, (_, i) => regs[start + i] ?? 0);
    },
  };
}

const CONFIG: InverterConfig = { phases: 1, hasBattery: true, pvStrings: 2, hasGenerator: false };

describe("1-phase total PV counter", () => {
  it("reads the 32-bit total low word first (reg 96 = low, reg 97 = high)", async () => {
    // A new inverter with 28.9 kWh lifetime: raw 289 in the low word, 0 in the high word.
    const inv = new DeyeInverter(fakeTransport({ 96: 289, 97: 0 }));
    const full = await inv.readFull(CONFIG);
    expect(full.totalPvKwh).toBe(28.9);
  });

  it("combines both words for totals above 6553.5 kWh", async () => {
    // 100000.0 kWh = raw 1,000,000 = 15 * 65536 + 16960
    const inv = new DeyeInverter(fakeTransport({ 96: 16960, 97: 15 }));
    const full = await inv.readFull(CONFIG);
    expect(full.totalPvKwh).toBe(100000);
  });
});
