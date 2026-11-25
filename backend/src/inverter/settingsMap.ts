/**
 * Declarative map of the writable 1-phase hybrid (Sunsynk-style) settings
 * registers. Register numbers follow the community kellerza/sunsynk
 * single-phase definitions; they are NOT verified on every Deye model, which
 * is why the UI ships read-first and writes sit behind a kill switch.
 *
 * Every field is described by a codec (plain scaled number, bitmask switch,
 * bitmask enum, or HHMM time). One table drives reading, validation and
 * read-modify-write, so the wire format cannot drift from the writes.
 */
import { toSigned } from "../solarman/modbus.js";

// ------------------------------------------------------------- wire format

export type TouCharge = "none" | "grid" | "gen" | "gridGen";
export type TouMode = "none" | "general" | "backup" | "charge";
export type LoadLimit = "allowExport" | "essentials" | "zeroExport";
export type AuxPort = "disable" | "smartload" | "generator";

export interface InverterTouSlot {
  /** Slot start, "HH:MM". */
  time: string;
  /** Max battery discharge power for the slot (W). */
  powerW: number;
  /** Target SOC for the slot (%). */
  capacityPct: number;
  /** Target battery voltage for voltage-managed batteries (V). */
  voltageV: number;
  /** Grid/generator charging permission during the slot. */
  charge: TouCharge;
  mode: TouMode;
  /** Allow selling to the grid during the slot. */
  sell: boolean;
}

export interface InverterSettings {
  /** false = battery first, true = load first. */
  priorityLoad: boolean;
  loadLimit: LoadLimit;
  solarSell: boolean;
  maxSellPowerW: number;
  maxSolarPowerW: number;
  battMaxChargeA: number;
  battMaxDischargeA: number;
  gridChargeA: number;
  gridChargeEnabled: boolean;
  battShutdownPct: number;
  battRestartPct: number;
  battLowPct: number;
  useTimer: boolean;
  touSlots: InverterTouSlot[];
  // --------------------------------------------------------------- advanced
  battShutdownV: number;
  battRestartV: number;
  battLowV: number;
  battEqualizationV: number;
  battAbsorptionV: number;
  battFloatV: number;
  /** Raw BMS protocol id (labels live in the UI). */
  bmsProtocol: number;
  auxPort: AuxPort;
  gridTrickleFeedW: number;
  peakShaving: boolean;
  genPeakShaving: boolean;
  gridPeakShaving: boolean;
  genPeakShavingW: number;
  gridPeakShavingW: number;
  inverterEnabled: boolean;
  /** Inverter clock, "YYYY-MM-DD HH:MM:SS" (read-only here; set via setClock). */
  clock?: string;
}

/** Sparse patch: top-level fields plus per-slot partial objects. */
export type InverterSettingsPatch = Partial<
  Omit<InverterSettings, "touSlots" | "clock">
> & {
  touSlots?: (Partial<InverterTouSlot> | null)[];
};

// -------------------------------------------------------------- descriptors

export type FieldDef =
  | {
      kind: "number";
      reg: number;
      scale: number;
      min: number;
      max: number;
      signed?: boolean;
      /** When the rated power is known it replaces `max`. */
      maxIsRated?: boolean;
    }
  | { kind: "switch"; reg: number; bitmask: number; on: number }
  | { kind: "enum"; reg: number; bitmask?: number; options: Record<string, number> }
  | { kind: "time"; reg: number };

/** Generous fallback cap for power fields when rated power is unreadable. */
const MAX_POWER_W = 20000;
const MIN_BATT_V = 41;
const MAX_BATT_V = 60;

export const FIELDS: Record<string, FieldDef> = {
  priorityLoad: { kind: "switch", reg: 243, bitmask: 0x01, on: 1 },
  loadLimit: {
    kind: "enum",
    reg: 244,
    options: { allowExport: 0, essentials: 1, zeroExport: 2 },
  },
  solarSell: { kind: "switch", reg: 247, bitmask: 0x01, on: 1 },
  maxSellPowerW: { kind: "number", reg: 245, scale: 1, min: 0, max: MAX_POWER_W, maxIsRated: true },
  maxSolarPowerW: { kind: "number", reg: 53, scale: 1, min: 0, max: MAX_POWER_W, maxIsRated: true },
  battMaxChargeA: { kind: "number", reg: 210, scale: 1, min: 0, max: 185 },
  battMaxDischargeA: { kind: "number", reg: 211, scale: 1, min: 0, max: 185 },
  gridChargeA: { kind: "number", reg: 230, scale: 1, min: 0, max: 185 },
  gridChargeEnabled: { kind: "switch", reg: 232, bitmask: 0x01, on: 1 },
  battShutdownPct: { kind: "number", reg: 217, scale: 1, min: 0, max: 100 },
  battRestartPct: { kind: "number", reg: 218, scale: 1, min: 0, max: 100 },
  battLowPct: { kind: "number", reg: 219, scale: 1, min: 0, max: 100 },
  useTimer: { kind: "switch", reg: 248, bitmask: 0x01, on: 1 },
  battShutdownV: { kind: "number", reg: 220, scale: 0.01, min: MIN_BATT_V, max: MAX_BATT_V },
  battRestartV: { kind: "number", reg: 221, scale: 0.01, min: MIN_BATT_V, max: MAX_BATT_V },
  battLowV: { kind: "number", reg: 222, scale: 0.01, min: MIN_BATT_V, max: MAX_BATT_V },
  battEqualizationV: { kind: "number", reg: 201, scale: 0.01, min: MIN_BATT_V, max: MAX_BATT_V },
  battAbsorptionV: { kind: "number", reg: 202, scale: 0.01, min: MIN_BATT_V, max: MAX_BATT_V },
  battFloatV: { kind: "number", reg: 203, scale: 0.01, min: MIN_BATT_V, max: MAX_BATT_V },
  bmsProtocol: { kind: "number", reg: 325, scale: 1, min: 0, max: 19 },
  auxPort: { kind: "enum", reg: 235, options: { disable: 0, smartload: 1, generator: 2 } },
  gridTrickleFeedW: { kind: "number", reg: 206, scale: 1, min: -500, max: 500, signed: true },
  peakShaving: { kind: "switch", reg: 280, bitmask: 0x000f, on: 0x0001 },
  genPeakShaving: { kind: "switch", reg: 280, bitmask: 0x00f0, on: 0x0010 },
  gridPeakShaving: { kind: "switch", reg: 280, bitmask: 0x0f00, on: 0x0100 },
  genPeakShavingW: { kind: "number", reg: 292, scale: 1, min: 0, max: MAX_POWER_W, maxIsRated: true },
  gridPeakShavingW: { kind: "number", reg: 293, scale: 1, min: 0, max: MAX_POWER_W, maxIsRated: true },
  inverterEnabled: { kind: "switch", reg: 43, bitmask: 0xffff, on: 1 },
};

export const TOU_SLOTS = 6;
for (let i = 0; i < TOU_SLOTS; i++) {
  FIELDS[`touSlots.${i}.time`] = { kind: "time", reg: 250 + i };
  FIELDS[`touSlots.${i}.powerW`] = {
    kind: "number", reg: 256 + i, scale: 1, min: 0, max: MAX_POWER_W, maxIsRated: true,
  };
  FIELDS[`touSlots.${i}.voltageV`] = {
    kind: "number", reg: 262 + i, scale: 0.01, min: MIN_BATT_V, max: MAX_BATT_V,
  };
  FIELDS[`touSlots.${i}.capacityPct`] = { kind: "number", reg: 268 + i, scale: 1, min: 0, max: 100 };
  FIELDS[`touSlots.${i}.charge`] = {
    kind: "enum", reg: 274 + i, bitmask: 0x03,
    options: { none: 0, grid: 1, gen: 2, gridGen: 3 },
  };
  FIELDS[`touSlots.${i}.mode`] = {
    kind: "enum", reg: 274 + i, bitmask: 0x1c,
    options: { none: 0, general: 4, backup: 8, charge: 12 },
  };
  FIELDS[`touSlots.${i}.sell`] = { kind: "switch", reg: 274 + i, bitmask: 0x40, on: 0x40 };
}

/** Contiguous register blocks that cover every field (plus clock and rated power). */
export const READ_BLOCKS = [
  { key: "rated", start: 16, count: 2 },
  { key: "clock", start: 22, count: 3 },
  { key: "enable", start: 43, count: 1 },
  { key: "maxSolar", start: 53, count: 1 },
  { key: "battery", start: 201, count: 35 }, // 201..235
  { key: "program", start: 243, count: 38 }, // 243..280
  { key: "peakShavingW", start: 292, count: 2 },
  { key: "bms", start: 325, count: 1 },
] as const;

export const CLOCK_REGS = { start: 22, count: 3 } as const;
export const RATED_REGS = { start: 16, count: 2 } as const;

// ------------------------------------------------------------------ codecs

export class SettingsValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
  }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Decode one field from the raw register bank; undefined when the reg is missing. */
export function decodeField(def: FieldDef, raw: Map<number, number>): unknown {
  const v = raw.get(def.reg);
  if (v === undefined) return undefined;
  switch (def.kind) {
    case "number": {
      const n = (def.signed ? toSigned(v) : v) * def.scale;
      // Avoid float dust on scaled values (e.g. 0.01 V steps).
      return def.scale < 1 ? Math.round(n * 100) / 100 : n;
    }
    case "switch":
      return (v & def.bitmask) === def.on;
    case "enum": {
      const masked = def.bitmask === undefined ? v : v & def.bitmask;
      const entry = Object.entries(def.options).find(([, n]) => n === masked);
      return entry ? entry[0] : undefined;
    }
    case "time": {
      const h = Math.floor(v / 100);
      const m = v % 100;
      if (h > 23 || m > 59) return undefined;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
}

/**
 * Encode one field value into the register bank (read-modify-write for
 * bitmasked fields). Throws SettingsValidationError on bad values.
 */
export function encodeField(
  key: string,
  def: FieldDef,
  value: unknown,
  raw: Map<number, number>,
  ratedPowerW: number | null,
): void {
  const current = raw.get(def.reg);
  if (current === undefined) {
    throw new SettingsValidationError([`${key}: register ${def.reg} is not readable on this inverter`]);
  }
  switch (def.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SettingsValidationError([`${key}: expected a number`]);
      }
      const max = def.maxIsRated && ratedPowerW ? ratedPowerW : def.max;
      if (value < def.min || value > max) {
        throw new SettingsValidationError([`${key}: must be between ${def.min} and ${max}`]);
      }
      const n = Math.round(value / def.scale);
      raw.set(def.reg, def.signed ? n & 0xffff : n);
      return;
    }
    case "switch": {
      if (typeof value !== "boolean") {
        throw new SettingsValidationError([`${key}: expected a boolean`]);
      }
      raw.set(def.reg, (current & ~def.bitmask) | (value ? def.on : 0));
      return;
    }
    case "enum": {
      if (typeof value !== "string" || !(value in def.options)) {
        throw new SettingsValidationError([
          `${key}: expected one of ${Object.keys(def.options).join(", ")}`,
        ]);
      }
      const n = def.options[value];
      const mask = def.bitmask ?? 0xffff;
      raw.set(def.reg, (current & ~mask) | n);
      return;
    }
    case "time": {
      if (typeof value !== "string" || !TIME_RE.test(value)) {
        throw new SettingsValidationError([`${key}: expected "HH:MM"`]);
      }
      const [h, m] = value.split(":").map(Number);
      raw.set(def.reg, h * 100 + m);
      return;
    }
  }
}

/** Decode the whole register bank into the wire settings object. */
export function decodeSettings(raw: Map<number, number>): Partial<InverterSettings> {
  const out: Record<string, unknown> = {};
  const slots: Record<number, Record<string, unknown>> = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    const value = decodeField(def, raw);
    if (value === undefined) continue;
    const m = key.match(/^touSlots\.(\d)\.(.+)$/);
    if (m) {
      const idx = Number(m[1]);
      (slots[idx] ??= {})[m[2]] = value;
    } else {
      out[key] = value;
    }
  }
  const slotList = Array.from({ length: TOU_SLOTS }, (_, i) => slots[i]).filter(
    (s): s is Record<string, unknown> => s !== undefined,
  );
  if (slotList.length === TOU_SLOTS) out.touSlots = slotList;

  const clock = decodeClock(raw);
  if (clock) out.clock = clock;
  return out as Partial<InverterSettings>;
}

/** Flatten a sparse patch into `FIELDS` keys; rejects unknown keys. */
export function flattenPatch(patch: InverterSettingsPatch): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "touSlots") {
      const slots = value as (Partial<InverterTouSlot> | null)[];
      if (!Array.isArray(slots) || slots.length > TOU_SLOTS) {
        throw new SettingsValidationError([`touSlots: expected up to ${TOU_SLOTS} entries`]);
      }
      slots.forEach((slot, i) => {
        if (!slot) return;
        for (const [sk, sv] of Object.entries(slot)) {
          if (sv === undefined) continue;
          const fk = `touSlots.${i}.${sk}`;
          if (!FIELDS[fk]) throw new SettingsValidationError([`unknown field ${fk}`]);
          flat.set(fk, sv);
        }
      });
      continue;
    }
    if (!FIELDS[key]) throw new SettingsValidationError([`unknown field ${key}`]);
    flat.set(key, value);
  }
  return flat;
}

/** Cross-field rules evaluated on the merged (current + patch) settings. */
export function crossFieldIssues(s: Partial<InverterSettings>): string[] {
  const issues: string[] = [];
  if (
    s.battShutdownPct !== undefined &&
    s.battLowPct !== undefined &&
    s.battShutdownPct > s.battLowPct
  ) {
    issues.push("battery shutdown SOC must not exceed the low-battery SOC");
  }
  if (
    s.battShutdownPct !== undefined &&
    s.battRestartPct !== undefined &&
    s.battRestartPct < s.battShutdownPct
  ) {
    issues.push("battery restart SOC must be at least the shutdown SOC");
  }
  if (
    s.battShutdownV !== undefined &&
    s.battLowV !== undefined &&
    s.battShutdownV > s.battLowV
  ) {
    issues.push("battery shutdown voltage must not exceed the low-battery voltage");
  }
  if (
    s.battShutdownV !== undefined &&
    s.battRestartV !== undefined &&
    s.battRestartV < s.battShutdownV
  ) {
    issues.push("battery restart voltage must be at least the shutdown voltage");
  }
  if (s.touSlots && s.touSlots.length === TOU_SLOTS) {
    const minutes = s.touSlots.map((slot) => {
      const [h, m] = slot.time.split(":").map(Number);
      return h * 60 + m;
    });
    // A valid schedule is a rotation of a sorted list: at most one descent
    // around the cycle (slots may wrap past midnight once).
    let descents = 0;
    for (let i = 0; i < minutes.length; i++) {
      if (minutes[(i + 1) % minutes.length] < minutes[i]) descents++;
    }
    if (descents > 1) {
      issues.push("time-of-use slot times must be in order (they may wrap past midnight once)");
    }
  }
  return issues;
}

// ------------------------------------------------------------------- clock

export interface ClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Registers 22..24: (year-2000)<<8|month, day<<8|hour, minute<<8|second. */
export function encodeClock(p: ClockParts): number[] {
  if (p.year < 2000 || p.year > 2255) {
    throw new SettingsValidationError(["clock: year out of range"]);
  }
  return [
    ((p.year - 2000) << 8) | p.month,
    (p.day << 8) | p.hour,
    (p.minute << 8) | p.second,
  ];
}

export function decodeClock(raw: Map<number, number>): string | null {
  const r22 = raw.get(22);
  const r23 = raw.get(23);
  const r24 = raw.get(24);
  if (r22 === undefined || r23 === undefined || r24 === undefined) return null;
  const year = 2000 + (r22 >> 8);
  const month = r22 & 0xff;
  const day = r23 >> 8;
  const hour = r23 & 0xff;
  const minute = r24 >> 8;
  const second = r24 & 0xff;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}:${p(second)}`;
}

/** Decode rated power from registers 16/17 (32-bit, low word first, 0.1 W). */
export function decodeRatedPower(raw: Map<number, number>): number | null {
  const lo = raw.get(16);
  const hi = raw.get(17);
  if (lo === undefined || hi === undefined) return null;
  const w = ((hi << 16) | lo) / 10;
  return w > 0 && w < 1_000_000 ? Math.round(w) : null;
}

/** Numeric limits per field key, substituting rated power where known. */
export function fieldLimits(ratedPowerW: number | null): Record<string, { min: number; max: number }> {
  const limits: Record<string, { min: number; max: number }> = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    if (def.kind !== "number") continue;
    limits[key] = {
      min: def.min,
      max: def.maxIsRated && ratedPowerW ? ratedPowerW : def.max,
    };
  }
  return limits;
}
