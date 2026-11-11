/**
 * Read and write inverter settings over a writable transport.
 *
 * This is the only code path in the application that writes to an inverter.
 * All access goes through the per-environment AsyncMutex shared with the
 * poller, so a settings operation never interleaves with a poll cycle.
 */
import type { WritableRegisterTransport } from "../solarman/transport.js";
import { AsyncMutex } from "../lib/mutex.js";
import {
  CLOCK_REGS,
  type ClockParts,
  crossFieldIssues,
  decodeField,
  decodeRatedPower,
  decodeSettings,
  encodeClock,
  encodeField,
  FIELDS,
  fieldLimits,
  flattenPatch,
  type InverterSettings,
  type InverterSettingsPatch,
  READ_BLOCKS,
  SettingsValidationError,
} from "./settingsMap.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ControlPacing {
  /** Pause between register reads so the logger isn't overwhelmed. */
  readMs: number;
  /** Longer pause between writes: settings land in flash. */
  writeMs: number;
}
const DEFAULT_PACING: ControlPacing = { readMs: 50, writeMs: 120 };
/** No pacing needed against an in-memory bank. */
export const NO_PACING: ControlPacing = { readMs: 0, writeMs: 0 };

export interface InverterSettingsReadResult {
  settings: Partial<InverterSettings>;
  /** Field keys whose registers could not be read on this inverter. */
  unsupported: string[];
  ratedPowerW: number | null;
  limits: Record<string, { min: number; max: number }>;
  readAt: string;
}

export interface ApplyFieldResult {
  key: string;
  ok: boolean;
  error?: string;
  /** Decoded value before the write (for the audit log). */
  from?: unknown;
  /** Requested value. */
  to?: unknown;
}

export interface InverterApplyResult {
  ok: boolean;
  results: ApplyFieldResult[];
  read: InverterSettingsReadResult;
}

export interface InverterControlSource {
  readSettings(): Promise<InverterSettingsReadResult>;
  applySettings(patch: InverterSettingsPatch): Promise<InverterApplyResult>;
  setClock(parts: ClockParts): Promise<void>;
}

interface RawRead {
  raw: Map<number, number>;
  unsupported: string[];
}

export class InverterControl implements InverterControlSource {
  constructor(
    private readonly transport: WritableRegisterTransport,
    private readonly mutex: AsyncMutex = new AsyncMutex(),
    private readonly pacing: ControlPacing = DEFAULT_PACING,
  ) {}

  readSettings(): Promise<InverterSettingsReadResult> {
    return this.mutex.runExclusive(async () => {
      try {
        await this.transport.connect();
        return this.decorate(await this.readAll());
      } finally {
        await this.transport.disconnect();
      }
    });
  }

  applySettings(patch: InverterSettingsPatch): Promise<InverterApplyResult> {
    return this.mutex.runExclusive(async () => {
      try {
        await this.transport.connect();
        return await this.applyUnlocked(patch);
      } finally {
        await this.transport.disconnect();
      }
    });
  }

  setClock(parts: ClockParts): Promise<void> {
    return this.mutex.runExclusive(async () => {
      try {
        await this.transport.connect();
        await this.transport.writeHoldingRegisters(CLOCK_REGS.start, encodeClock(parts));
      } finally {
        await this.transport.disconnect();
      }
    });
  }

  // ------------------------------------------------------------------ internals

  private async readAll(): Promise<RawRead> {
    const raw = new Map<number, number>();
    const failedBlocks = new Set<string>();
    for (const block of READ_BLOCKS) {
      try {
        const values = await this.transport.readHoldingRegisters(block.start, block.count);
        values.forEach((v, i) => raw.set(block.start + i, v));
      } catch {
        failedBlocks.add(block.key);
      }
      await sleep(this.pacing.readMs);
    }
    const unsupported = Object.entries(FIELDS)
      .filter(([, def]) => !raw.has(def.reg))
      .map(([key]) => key);
    return { raw, unsupported };
  }

  private decorate({ raw, unsupported }: RawRead): InverterSettingsReadResult {
    const ratedPowerW = decodeRatedPower(raw);
    return {
      settings: decodeSettings(raw),
      unsupported,
      ratedPowerW,
      limits: fieldLimits(ratedPowerW),
      readAt: new Date().toISOString(),
    };
  }

  private async applyUnlocked(patch: InverterSettingsPatch): Promise<InverterApplyResult> {
    const flat = flattenPatch(patch);
    if (flat.size === 0) {
      throw new SettingsValidationError(["empty patch: nothing to change"]);
    }

    const before = await this.readAll();
    const ratedPowerW = decodeRatedPower(before.raw);

    // Reject fields whose backing register is unreadable on this inverter.
    const issues: string[] = [];
    for (const key of flat.keys()) {
      if (before.unsupported.includes(key)) {
        issues.push(`${key}: not supported by this inverter`);
      }
    }
    if (issues.length > 0) throw new SettingsValidationError(issues);

    // Encode into a copy of the raw bank (read-modify-write for packed regs).
    const next = new Map(before.raw);
    for (const [key, value] of [...flat.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      encodeField(key, FIELDS[key], value, next, ratedPowerW);
    }

    // Cross-field rules on the merged view.
    const crossIssues = crossFieldIssues(decodeSettings(next));
    if (crossIssues.length > 0) throw new SettingsValidationError(crossIssues);

    // Write only registers whose value changed, re-reading each to verify.
    const changedRegs = [...next.keys()]
      .filter((reg) => next.get(reg) !== before.raw.get(reg))
      .sort((a, b) => a - b);
    const regOutcome = new Map<number, string | null>(); // null = ok
    for (const reg of changedRegs) {
      const value = next.get(reg)!;
      try {
        await this.transport.writeHoldingRegister(reg, value);
        await sleep(this.pacing.writeMs);
        const [readBack] = await this.transport.readHoldingRegisters(reg, 1);
        regOutcome.set(
          reg,
          readBack === value
            ? null
            : `inverter kept ${readBack} after writing ${value} (value rejected?)`,
        );
      } catch (err) {
        regOutcome.set(reg, (err as Error).message);
      }
      await sleep(this.pacing.writeMs);
    }

    const results: ApplyFieldResult[] = [...flat.entries()].map(([key, to]) => {
      const def = FIELDS[key];
      const outcome = regOutcome.get(def.reg);
      const base = { key, from: decodeField(def, before.raw), to };
      if (outcome === undefined) return { ...base, ok: true }; // already at target value
      return outcome === null ? { ...base, ok: true } : { ...base, ok: false, error: outcome };
    });

    const read = this.decorate(await this.readAll());
    return { ok: results.every((r) => r.ok), results, read };
  }
}

// ------------------------------------------------------------- simulation

/**
 * In-memory register bank implementing the writable transport, so the
 * simulator exercises exactly the same codec/control code as real hardware.
 */
export class MemoryRegisterBank implements WritableRegisterTransport {
  constructor(private readonly regs: Map<number, number>) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async readHoldingRegisters(startAddr: number, quantity: number): Promise<number[]> {
    return Array.from({ length: quantity }, (_, i) => this.regs.get(startAddr + i) ?? 0);
  }

  async writeHoldingRegister(addr: number, value: number): Promise<void> {
    this.regs.set(addr, value & 0xffff);
  }

  async writeHoldingRegisters(startAddr: number, values: number[]): Promise<void> {
    values.forEach((v, i) => this.regs.set(startAddr + i, v & 0xffff));
  }
}

/** Plausible defaults for a 6 kW single-phase hybrid with a 48 V battery. */
export function defaultSimulatedRegisters(now: Date = new Date()): Map<number, number> {
  const regs = new Map<number, number>();
  // Rated power 6000 W (0.1 W units, low word first).
  regs.set(16, 60000 & 0xffff);
  regs.set(17, 60000 >> 16);
  regs.set(22, ((now.getFullYear() - 2000) << 8) | (now.getMonth() + 1));
  regs.set(23, (now.getDate() << 8) | now.getHours());
  regs.set(24, (now.getMinutes() << 8) | now.getSeconds());
  regs.set(43, 1); // inverter enabled
  regs.set(53, 6000); // max solar power
  regs.set(201, 5700); // equalization 57.00 V
  regs.set(202, 5700); // absorption 57.00 V
  regs.set(203, 5520); // float 55.20 V
  regs.set(206, 0); // trickle feed
  regs.set(210, 100); // max charge A
  regs.set(211, 100); // max discharge A
  regs.set(217, 10); // shutdown SOC
  regs.set(218, 15); // restart SOC
  regs.set(219, 20); // low SOC
  regs.set(220, 4600); // shutdown V
  regs.set(221, 4800); // restart V
  regs.set(222, 4700); // low V
  regs.set(230, 40); // grid charge A
  regs.set(232, 0); // grid charge off
  regs.set(235, 0); // aux disabled
  regs.set(243, 0); // battery first
  regs.set(244, 2); // zero export
  regs.set(245, 6000); // max sell W
  regs.set(247, 0); // solar sell off
  regs.set(248, 0); // timer off
  const times = [0, 400, 800, 1200, 1600, 2000];
  const caps = [100, 100, 30, 30, 30, 60];
  for (let i = 0; i < 6; i++) {
    regs.set(250 + i, times[i]);
    regs.set(256 + i, 3000); // slot power
    regs.set(262 + i, 4900); // slot voltage 49.00 V
    regs.set(268 + i, caps[i]); // slot capacity
    regs.set(274 + i, 4); // mode: general, no grid/gen charge, no sell
  }
  regs.set(280, 0);
  regs.set(292, 0);
  regs.set(293, 0);
  regs.set(325, 0); // BMS: Pylon CAN
  return regs;
}

/** Control backed by an in-memory bank, for simulator environments and tests. */
export function createSimulatedControl(mutex?: AsyncMutex): InverterControl {
  return new InverterControl(
    new MemoryRegisterBank(defaultSimulatedRegisters()),
    mutex,
    NO_PACING,
  );
}
