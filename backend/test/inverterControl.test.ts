import { describe, expect, it } from "vitest";
import {
  crossFieldIssues,
  decodeClock,
  decodeSettings,
  encodeClock,
  encodeField,
  FIELDS,
  flattenPatch,
  SettingsValidationError,
  type InverterSettings,
} from "../src/inverter/settingsMap.js";
import {
  createSimulatedControl,
  defaultSimulatedRegisters,
  InverterControl,
  NO_PACING,
  MemoryRegisterBank,
} from "../src/inverter/control.js";

describe("settings codecs", () => {
  it("decodes the simulated bank into a complete settings object", () => {
    const settings = decodeSettings(defaultSimulatedRegisters());
    expect(settings.priorityLoad).toBe(false);
    expect(settings.loadLimit).toBe("zeroExport");
    expect(settings.battFloatV).toBe(55.2);
    expect(settings.touSlots).toHaveLength(6);
    expect(settings.touSlots![1]).toMatchObject({
      time: "04:00",
      powerW: 3000,
      capacityPct: 100,
      mode: "general",
      charge: "none",
      sell: false,
    });
  });

  it("round-trips a packed TOU register (charge + mode + sell share reg 274)", () => {
    const raw = defaultSimulatedRegisters();
    encodeField("touSlots.0.charge", FIELDS["touSlots.0.charge"], "grid", raw, null);
    encodeField("touSlots.0.sell", FIELDS["touSlots.0.sell"], true, raw, null);
    // mode (general = 4) must be preserved by the read-modify-writes.
    expect(raw.get(274)).toBe(4 | 1 | 0x40);
    const settings = decodeSettings(raw);
    expect(settings.touSlots![0]).toMatchObject({ charge: "grid", mode: "general", sell: true });
  });

  it("encodes signed trickle feed as two's complement", () => {
    const raw = defaultSimulatedRegisters();
    encodeField("gridTrickleFeedW", FIELDS.gridTrickleFeedW, -200, raw, null);
    expect(raw.get(206)).toBe(0x10000 - 200);
    expect(decodeSettings(raw).gridTrickleFeedW).toBe(-200);
  });

  it("encodes HH:MM times and rejects invalid ones", () => {
    const raw = defaultSimulatedRegisters();
    encodeField("touSlots.2.time", FIELDS["touSlots.2.time"], "21:30", raw, null);
    expect(raw.get(252)).toBe(2130);
    expect(() =>
      encodeField("touSlots.2.time", FIELDS["touSlots.2.time"], "24:00", raw, null),
    ).toThrow(SettingsValidationError);
  });

  it("enforces numeric ranges, using rated power for power fields", () => {
    const raw = defaultSimulatedRegisters();
    expect(() => encodeField("battMaxChargeA", FIELDS.battMaxChargeA, 200, raw, null)).toThrow(
      /between 0 and 185/,
    );
    expect(() => encodeField("maxSellPowerW", FIELDS.maxSellPowerW, 7000, raw, 6000)).toThrow(
      /between 0 and 6000/,
    );
    expect(() => encodeField("maxSellPowerW", FIELDS.maxSellPowerW, 7000, raw, null)).not.toThrow();
  });

  it("round-trips the clock encoding", () => {
    const regs = encodeClock({ year: 2026, month: 11, day: 10, hour: 9, minute: 5, second: 30 });
    const raw = new Map([[22, regs[0]], [23, regs[1]], [24, regs[2]]]);
    expect(decodeClock(raw)).toBe("2026-11-10 09:05:30");
  });

  it("rejects unknown patch fields", () => {
    expect(() => flattenPatch({ nope: 1 } as never)).toThrow(/unknown field nope/);
    expect(() => flattenPatch({ touSlots: [{ bogus: 1 } as never] })).toThrow(
      /unknown field touSlots.0.bogus/,
    );
  });
});

describe("cross-field validation", () => {
  const base = decodeSettings(defaultSimulatedRegisters()) as InverterSettings;

  it("accepts the defaults", () => {
    expect(crossFieldIssues(base)).toEqual([]);
  });

  it("rejects shutdown SOC above low SOC", () => {
    expect(crossFieldIssues({ ...base, battShutdownPct: 30, battLowPct: 20 })).toContainEqual(
      expect.stringContaining("shutdown SOC"),
    );
  });

  it("rejects restart below shutdown", () => {
    expect(crossFieldIssues({ ...base, battShutdownPct: 15, battRestartPct: 10 })).toContainEqual(
      expect.stringContaining("restart SOC"),
    );
  });

  it("allows a schedule wrapping midnight once, rejects a scrambled one", () => {
    const wrap = base.touSlots.map((s, i) => ({
      ...s,
      time: ["22:00", "23:30", "01:00", "05:00", "08:00", "12:00"][i],
    }));
    expect(crossFieldIssues({ ...base, touSlots: wrap })).toEqual([]);

    const scrambled = base.touSlots.map((s, i) => ({
      ...s,
      time: ["08:00", "02:00", "12:00", "04:00", "16:00", "20:00"][i],
    }));
    expect(crossFieldIssues({ ...base, touSlots: scrambled })).toContainEqual(
      expect.stringContaining("slot times"),
    );
  });
});

describe("InverterControl.applySettings", () => {
  it("writes only changed registers and verifies the read-back", async () => {
    const regs = defaultSimulatedRegisters();
    const bank = new MemoryRegisterBank(regs);
    const writes: number[] = [];
    const origWrite = bank.writeHoldingRegister.bind(bank);
    bank.writeHoldingRegister = async (addr, value) => {
      writes.push(addr);
      await origWrite(addr, value);
    };
    const control = new InverterControl(bank, undefined, NO_PACING);

    const result = await control.applySettings({
      priorityLoad: true,
      maxSellPowerW: 6000, // already 6000: must not be written
      touSlots: [null, null, { time: "05:00", capacityPct: 40 }],
    });

    expect(result.ok).toBe(true);
    expect(writes.sort((a, b) => a - b)).toEqual([243, 252, 270]);
    expect(result.read.settings.priorityLoad).toBe(true);
    expect(result.read.settings.touSlots![2]).toMatchObject({ time: "05:00", capacityPct: 40 });
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  it("rejects cross-field violations without writing anything", async () => {
    const regs = defaultSimulatedRegisters();
    const bank = new MemoryRegisterBank(regs);
    let wrote = false;
    bank.writeHoldingRegister = async () => {
      wrote = true;
    };
    const control = new InverterControl(bank, undefined, NO_PACING);
    await expect(
      control.applySettings({ battShutdownPct: 40, battLowPct: 20 }),
    ).rejects.toThrow(SettingsValidationError);
    expect(wrote).toBe(false);
  });

  it("reports a per-field error when the inverter rejects the value", async () => {
    const regs = defaultSimulatedRegisters();
    const bank = new MemoryRegisterBank(regs);
    bank.writeHoldingRegister = async () => {
      // Inverter silently keeps the old value.
    };
    const control = new InverterControl(bank, undefined, NO_PACING);
    const result = await control.applySettings({ priorityLoad: true, gridChargeA: 60 });
    expect(result.ok).toBe(false);
    for (const r of result.results) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/kept/);
    }
  });

  it("marks fields on unreadable registers as unsupported", async () => {
    const regs = defaultSimulatedRegisters();
    const bank = new MemoryRegisterBank(regs);
    const origRead = bank.readHoldingRegisters.bind(bank);
    bank.readHoldingRegisters = async (start, quantity) => {
      if (start === 325) throw new Error("illegal data address");
      return origRead(start, quantity);
    };
    const control = new InverterControl(bank, undefined, NO_PACING);
    const read = await control.readSettings();
    expect(read.unsupported).toContain("bmsProtocol");
    expect(read.settings.bmsProtocol).toBeUndefined();
    await expect(control.applySettings({ bmsProtocol: 1 })).rejects.toThrow(/not supported/);
  });

  it("simulated control reads a full settings object with limits", async () => {
    const control = createSimulatedControl();
    const read = await control.readSettings();
    expect(read.unsupported).toEqual([]);
    expect(read.ratedPowerW).toBe(6000);
    expect(read.limits.maxSellPowerW).toEqual({ min: 0, max: 6000 });
    expect(read.settings.clock).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("sets the clock via a multi-register write", async () => {
    const regs = defaultSimulatedRegisters();
    const control = new InverterControl(new MemoryRegisterBank(regs), undefined, NO_PACING);
    await control.setClock({ year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5 });
    expect(regs.get(22)).toBe((26 << 8) | 1);
    expect(regs.get(23)).toBe((2 << 8) | 3);
    expect(regs.get(24)).toBe((4 << 8) | 5);
  });
});
