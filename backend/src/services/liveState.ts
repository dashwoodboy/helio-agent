import { EventEmitter } from "node:events";
import type { FullReading, InverterConfig, LiveReading } from "../inverter/types.js";
import type { EnergyFlows } from "./flows.js";
import type { ChargeEstimate } from "./chargeEta.js";

export interface LiveSnapshot extends LiveReading {
  flows: EnergyFlows;
  chargeEstimate: ChargeEstimate | null;
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
  online: boolean;
  lastUpdated: string;
  /** Self-sufficiency today (0-100), derived from flow attribution. */
  selfSufficiencyPct: number | null;
  selfConsumptionPct: number | null;
}

export interface AlertEvent {
  id: number;
  rule: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  ts: string;
}

/**
 * Holds the latest merged reading and fans out updates to the
 * WebSocket layer and the alert engine.
 */
export class LiveState extends EventEmitter {
  private snapshot: LiveSnapshot | null = null;
  private lastFull: Partial<FullReading> = {};
  private consecutiveFailures = 0;
  config: InverterConfig | null = null;

  get current(): LiveSnapshot | null {
    return this.snapshot;
  }

  get online(): boolean {
    return this.consecutiveFailures < 3 && this.snapshot !== null;
  }

  updateFull(reading: FullReading, extras: Extras): void {
    this.lastFull = reading;
    this.applyLive(reading, extras);
  }

  updateLive(reading: LiveReading, extras: Extras): void {
    this.applyLive(reading, extras);
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === 3 && this.snapshot) {
      this.snapshot = { ...this.snapshot, online: false };
      this.emit("live", this.snapshot);
    }
  }

  /** Force the offline state immediately (e.g. the stick disconnected). */
  markOffline(): void {
    this.consecutiveFailures = Math.max(this.consecutiveFailures, 3);
    if (this.snapshot?.online) {
      this.snapshot = { ...this.snapshot, online: false };
      this.emit("live", this.snapshot);
    }
  }

  private applyLive(reading: LiveReading, extras: Extras): void {
    this.consecutiveFailures = 0;
    const full = this.lastFull;
    this.snapshot = {
      ...reading,
      flows: extras.flows,
      chargeEstimate: extras.chargeEstimate,
      dcTemp: full.dcTemp ?? null,
      heatsinkTemp: full.heatsinkTemp ?? null,
      dailyPvKwh: full.dailyPvKwh ?? 0,
      dailyImportKwh: full.dailyImportKwh ?? 0,
      dailyExportKwh: full.dailyExportKwh ?? 0,
      dailyLoadKwh: full.dailyLoadKwh ?? 0,
      dailyBattChargeKwh: full.dailyBattChargeKwh ?? null,
      dailyBattDischargeKwh: full.dailyBattDischargeKwh ?? null,
      totalPvKwh: full.totalPvKwh ?? null,
      batteryCapacityAh: full.batteryCapacityAh ?? null,
      batteryNominalV: full.batteryNominalV ?? null,
      online: true,
      lastUpdated: new Date().toISOString(),
      selfSufficiencyPct: extras.selfSufficiencyPct,
      selfConsumptionPct: extras.selfConsumptionPct,
    };
    this.emit("live", this.snapshot);
  }

  emitAlert(alert: AlertEvent): void {
    this.emit("alert", alert);
  }
}

interface Extras {
  flows: EnergyFlows;
  chargeEstimate: ChargeEstimate | null;
  selfSufficiencyPct: number | null;
  selfConsumptionPct: number | null;
}
