export interface InverterConfig {
  phases: 1 | 3;
  hasBattery: boolean;
  pvStrings: 1 | 2;
  hasGenerator: boolean;
  /**
   * 3-phase only: high-voltage battery family (SG01HP3, device type 0x06xx),
   * which scales battery voltage by 0.1 V and PV power by 10 W. Undefined on
   * 1-phase and on 3-phase configs cached before this field existed.
   */
  hv?: boolean;
}

export type BatteryStatus = "charging" | "discharging" | "idle" | "none";
export type GridStatus = "importing" | "exporting" | "idle" | "offline";

/** Fast-changing values read every poll tick. */
export interface LiveReading {
  pv1W: number;
  pv2W: number;
  pvW: number;
  /** Battery power in W; positive = charging, negative = discharging. */
  battW: number;
  battV: number;
  battA: number;
  soc: number;
  socRaw: number;
  gridV: number;
  /** Grid power in W; positive = importing, negative = exporting. */
  gridW: number;
  gridHz: number | null;
  loadW: number;
  genW: number;
  l1W: number | null;
  l2W: number | null;
  l3W: number | null;
  l1V: number | null;
  l2V: number | null;
  l3V: number | null;
  batteryStatus: BatteryStatus;
  gridStatus: GridStatus;
}

/** Everything in LiveReading plus slow-changing values (read ~1/min). */
export interface FullReading extends LiveReading {
  dcTemp: number | null;
  heatsinkTemp: number | null;
  dailyPvKwh: number;
  dailyImportKwh: number;
  dailyExportKwh: number;
  dailyLoadKwh: number;
  dailyBattChargeKwh: number | null;
  dailyBattDischargeKwh: number | null;
  totalPvKwh: number | null;
  batteryCapacityAh: number | null;
  batteryNominalV: number | null;
}

/** Common interface for the real inverter and the simulator. */
export interface InverterSource {
  detectConfig(): Promise<InverterConfig>;
  readLive(config: InverterConfig): Promise<LiveReading>;
  readFull(config: InverterConfig): Promise<FullReading>;
  close(): Promise<void>;
}

export function deriveStatuses(reading: {
  battA: number;
  gridW: number;
  gridV: number;
  hasBattery: boolean;
}): { batteryStatus: BatteryStatus; gridStatus: GridStatus } {
  let batteryStatus: BatteryStatus = "none";
  if (reading.hasBattery) {
    if (reading.battA > 0.05) batteryStatus = "charging";
    else if (reading.battA < -0.05) batteryStatus = "discharging";
    else batteryStatus = "idle";
  }
  let gridStatus: GridStatus;
  if (reading.gridV < 80) gridStatus = "offline";
  else if (reading.gridW > 0) gridStatus = "importing";
  else if (reading.gridW < 0) gridStatus = "exporting";
  else gridStatus = "idle";
  return { batteryStatus, gridStatus };
}
