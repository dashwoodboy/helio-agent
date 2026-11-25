/**
 * Register images: project a simulator reading onto the raw holding-register
 * banks a real Deye inverter would expose, so simulated environments and
 * tests exercise the very same register-map code (DeyeInverter) as real
 * hardware. A demo that returned readings straight from the simulator would
 * never catch a wrong register address — this layer does.
 *
 * The 3-phase image deliberately includes the "trap" registers that a wrong
 * map would read: 502 (day inverter AC output, not PV), 514/515 (day battery
 * charge/discharge, not PV power), 586 (battery temperature, not current)
 * and 607 (grid inner-side power, not the grid total at 625).
 */
import { ModbusError } from "../solarman/modbus.js";
import type { RegisterTransport } from "../solarman/transport.js";
import type { FullReading, InverterConfig, InverterSource } from "./types.js";

const toU16 = (v: number) => ((Math.round(v) % 0x10000) + 0x10000) % 0x10000;

/** Build the 1-phase (Sunsynk-style) register bank from a simulator reading. */
export function registersFrom1p(full: FullReading): Map<number, number> {
  const regs = new Map<number, number>();
  // The whole real-time area exists on the device; unknown registers read 0.
  for (let addr = 59; addr <= 199; addr++) regs.set(addr, 0);
  const set = (addr: number, v: number) => regs.set(addr, toU16(v));

  set(0, 0x0300); // device type: single-phase hybrid
  set(59, 2); // run state: normal
  set(150, full.gridV * 10);
  // Live block A (166..178)
  set(166, full.genW);
  set(169, full.gridW);
  set(176, full.l1W ?? full.loadW);
  set(178, full.loadW);
  // Live block B (183..191)
  set(183, full.battV * 100);
  set(184, full.socRaw);
  set(186, full.pv1W);
  set(187, full.pv2W);
  set(191, -(full.battA * 100)); // stored negated, reader negates back
  // Optional / slow registers
  if (full.gridHz !== null) set(79, full.gridHz * 100);
  set(90, (full.dcTemp ?? 30) * 10 + 1000);
  set(91, (full.heatsinkTemp ?? 28) * 10 + 1000);
  set(108, full.dailyPvKwh * 10);
  set(76, full.dailyImportKwh * 10);
  set(77, full.dailyExportKwh * 10);
  set(84, full.dailyLoadKwh * 10);
  set(70, (full.dailyBattChargeKwh ?? 0) * 10);
  set(71, (full.dailyBattDischargeKwh ?? 0) * 10);
  const totalPv = Math.round((full.totalPvKwh ?? 0) * 10);
  // Low word first, like the real inverter.
  set(96, totalPv & 0xffff);
  set(97, (totalPv >> 16) & 0xffff);
  set(107, full.batteryCapacityAh ?? 300);
  set(236, (full.batteryNominalV ?? 52) * 100);
  return regs;
}

export interface ThreePhaseImageOptions {
  /** High-voltage battery model (SG01HP3): 0.1 V battery, 10 W PV steps. */
  hv?: boolean;
}

/**
 * Build the 3-phase register bank (registers 500-730 family) from a
 * simulator reading, following the documented Deye three-phase map
 * (SG04LP3 low-voltage; SG01HP3 high-voltage with `hv`).
 *
 * Registers 500..683 all exist (unknown ones read 0), like real hardware.
 */
export function registersFrom3p(
  full: FullReading,
  opts: ThreePhaseImageOptions = {},
): Map<number, number> {
  const hv = opts.hv ?? false;
  const regs = new Map<number, number>();
  // The whole real-time area exists on the device; defaults are 0.
  for (let addr = 500; addr <= 683; addr++) regs.set(addr, 0);
  const set = (addr: number, v: number) => regs.set(addr, toU16(v));

  // Device family: 0x05xx = LV three-phase, 0x06xx = HV three-phase.
  set(0, hv ? 0x0601 : 0x0500);
  set(1, 1); // modbus address
  set(2, 105); // protocol version

  set(500, 2); // run state: normal
  // TRAP: 502 is the day *inverter AC output* energy, not PV production.
  set(502, (full.dailyLoadKwh + full.dailyExportKwh) * 10);
  // TRAP: 514/515 are day battery charge/discharge (0.1 kWh), not PV power.
  set(514, (full.dailyBattChargeKwh ?? 0) * 10);
  set(515, (full.dailyBattDischargeKwh ?? 0) * 10);
  set(520, full.dailyImportKwh * 10);
  set(521, full.dailyExportKwh * 10);
  set(526, full.dailyLoadKwh * 10);
  set(529, full.dailyPvKwh * 10);
  const totalPv = Math.round((full.totalPvKwh ?? 0) * 10);
  set(534, totalPv & 0xffff); // low word first
  set(535, (totalPv >> 16) & 0xffff);

  set(540, (full.dcTemp ?? 30) * 10 + 1000);
  set(541, (full.heatsinkTemp ?? 28) * 10 + 1000);

  // TRAP: 586 is the battery *temperature*, not current.
  set(586, 25 * 10 + 1000);
  set(587, full.battV * (hv ? 10 : 100));
  set(588, full.socRaw);
  // Battery power/current: raw positive = discharging (reader negates back).
  set(590, -(full.battW / (hv ? 10 : 1)));
  set(591, -(full.battA * 100));

  // Grid phase voltages (0.1 V).
  set(598, full.gridV * 10);
  set(599, (full.l2V ?? full.gridV) * 10);
  set(600, (full.l3V ?? full.gridV) * 10);
  // TRAP: 604..607 are the grid *inner-side* powers (through the inverter's
  // AC port), not the grid total: at night, on battery, 607 is positive
  // while the grid total (625) is 0.
  const innerW = full.loadW - full.gridW;
  set(604, Math.round(innerW * 0.45));
  set(605, Math.round(innerW * 0.33));
  set(606, innerW - Math.round(innerW * 0.45) - Math.round(innerW * 0.33));
  set(607, innerW);
  set(608, Math.abs(innerW));
  if (full.gridHz !== null) set(609, full.gridHz * 100);

  // External CT / total grid power (signed, positive = importing).
  set(616, Math.round(full.gridW * 0.45));
  set(617, Math.round(full.gridW * 0.33));
  set(618, full.gridW - Math.round(full.gridW * 0.45) - Math.round(full.gridW * 0.33));
  set(619, full.gridW);
  set(622, Math.round(full.gridW * 0.45));
  set(623, Math.round(full.gridW * 0.33));
  set(624, full.gridW - Math.round(full.gridW * 0.45) - Math.round(full.gridW * 0.33));
  set(625, full.gridW);

  // Inverter output voltages / frequency.
  set(627, full.gridV * 10);
  set(628, (full.l2V ?? full.gridV) * 10);
  set(629, (full.l3V ?? full.gridV) * 10);
  if (full.gridHz !== null) set(638, full.gridHz * 100);

  // Load-side voltages and per-phase loads.
  set(644, (full.l1V ?? full.gridV) * 10);
  set(645, (full.l2V ?? full.gridV) * 10);
  set(646, (full.l3V ?? full.gridV) * 10);
  set(650, full.l1W ?? full.loadW);
  set(651, full.l2W ?? 0);
  set(652, full.l3W ?? 0);
  set(653, full.loadW);

  set(667, full.genW);

  // PV string powers (LV: 1 W, HV: 10 W) and DC voltages/currents.
  set(672, full.pv1W / (hv ? 10 : 1));
  set(673, full.pv2W / (hv ? 10 : 1));
  set(676, 320 * 10); // PV1 voltage, 0.1 V
  set(677, (full.pv1W / 320) * 10); // PV1 current, 0.1 A
  set(678, 315 * 10);
  set(679, (full.pv2W / 315) * 10);

  return regs;
}

export interface SimulatedTransportOptions {
  phases: 1 | 3;
  hv?: boolean;
  /** How long one register image stays coherent across block reads. */
  refreshMs?: number;
  now?: () => number;
}

/**
 * RegisterTransport backed by a simulator: every read is answered from a
 * register image rebuilt at most once per refresh window, so the blocks a
 * poll cycle reads stay coherent with each other. Unknown addresses fail
 * with the Modbus "illegal data address" error, like real hardware.
 */
export class SimulatedRegisterTransport implements RegisterTransport {
  private image: Map<number, number> | null = null;
  private imageAt = 0;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly config: InverterConfig;

  constructor(
    private readonly simulator: InverterSource,
    private readonly opts: SimulatedTransportOptions,
  ) {
    this.refreshMs = opts.refreshMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.config = {
      phases: opts.phases,
      hasBattery: true,
      pvStrings: 2,
      hasGenerator: false,
    };
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async readHoldingRegisters(startAddr: number, quantity: number): Promise<number[]> {
    if (!this.image || this.now() - this.imageAt >= this.refreshMs) {
      const full = await this.simulator.readFull(this.config);
      this.image =
        this.opts.phases === 3
          ? registersFrom3p(full, { hv: this.opts.hv })
          : registersFrom1p(full);
      this.imageAt = this.now();
    }
    const values: number[] = [];
    for (let i = 0; i < quantity; i++) {
      const v = this.image.get(startAddr + i);
      if (v === undefined) {
        throw new ModbusError("Modbus exception code 2 (illegal data address)");
      }
      values.push(v);
    }
    return values;
  }
}
