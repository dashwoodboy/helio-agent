import type { Db } from "../db/client.js";
import { notifications } from "../db/schema.js";
import { localDateKey } from "../lib/time.js";
import type { LiveSnapshot, LiveState } from "./liveState.js";
import type { SettingsService } from "./settings.js";
import type { GeneratorTracker, OutageTracker } from "./trackers.js";
import type { WeatherWarning } from "./weather.js";

type Severity = "info" | "warning" | "critical";

interface FiredAlert {
  rule: string;
  severity: Severity;
  title: string;
  body: string;
}

/** Minimum time between repeats of the same rule. */
const COOLDOWN_MS: Record<string, number> = {
  socLow: 60 * 60000,
  socCritical: 30 * 60000,
  batteryFull: 6 * 3600000,
  tempHigh: 30 * 60000,
  gridVOutOfRange: 30 * 60000,
  inverterOffline: 30 * 60000,
  pvUnderperforming: 12 * 3600000,
  stormWarning: 12 * 3600000,
};

/** Alert when actual PV lands ≥30% below the (calibrated) forecast. */
export const PV_UNDERPERFORMANCE_FACTOR = 0.7;

/**
 * Evaluates alert rules on live samples and lifecycle events, stores
 * notifications and pushes them over the live WebSocket stream.
 */
export class AlertEngine {
  private lastFired = new Map<string, number>();
  private wasOnline = true;
  private evalCounter = 0;

  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
    private readonly liveState: LiveState,
    private readonly settingsService: SettingsService,
    private readonly outageTracker: OutageTracker,
    private readonly generatorTracker: GeneratorTracker,
  ) {}

  private liveListener: ((snap: LiveSnapshot) => void) | null = null;

  start(): void {
    this.liveListener = (snap: LiveSnapshot) => {
      // Evaluate at most every 6th sample (~30s at 5s polling).
      this.evalCounter++;
      if (this.evalCounter % 6 !== 0) return;
      void this.evaluate(snap);
    };
    this.liveState.on("live", this.liveListener);

    this.outageTracker.onStart = (startedAt) => {
      void this.fire({
        rule: "gridLost",
        severity: "critical",
        title: "Grid power lost",
        body: `Outage started at ${startedAt.toTimeString().slice(0, 5)}. Running on battery.`,
      });
    };
    this.outageTracker.onEnd = (_startedAt, _endedAt, durationS) => {
      const minutes = Math.round(durationS / 60);
      void this.fire({
        rule: "gridRestored",
        severity: "info",
        title: "Grid power restored",
        body: `Outage lasted ${Math.floor(minutes / 60)}h ${minutes % 60}m.`,
      });
    };
    this.generatorTracker.onStart = () => {
      void this.fire({
        rule: "generatorStarted",
        severity: "warning",
        title: "Generator started",
        body: "The generator is now running.",
      });
    };
    this.generatorTracker.onStop = (runtimeS) => {
      const minutes = Math.round(runtimeS / 60);
      void this.fire({
        rule: "generatorStopped",
        severity: "info",
        title: "Generator stopped",
        body: `Ran for ${Math.floor(minutes / 60)}h ${minutes % 60}m.`,
      });
    };
  }

  stop(): void {
    if (this.liveListener) this.liveState.off("live", this.liveListener);
    this.liveListener = null;
    this.outageTracker.onStart = null;
    this.outageTracker.onEnd = null;
    this.generatorTracker.onStart = null;
    this.generatorTracker.onStop = null;
  }

  private async evaluate(snap: LiveSnapshot): Promise<void> {
    const s = this.settingsService.get();
    if (!s.alertsEnabled) return;

    // Offline transition
    if (!snap.online && this.wasOnline) {
      await this.fire({
        rule: "inverterOffline",
        severity: "warning",
        title: "Inverter unreachable",
        body: "No successful reads from the inverter for several polls.",
      });
    }
    this.wasOnline = snap.online;
    if (!snap.online) return;

    const hasBattery = this.liveState.config?.hasBattery ?? true;
    if (hasBattery && snap.soc > 0) {
      if (snap.soc <= Math.max(5, s.alertSocLowPct - 10)) {
        await this.fire({
          rule: "socCritical",
          severity: "critical",
          title: `Battery critically low (${snap.soc}%)`,
          body: "Consider reducing load or starting a backup source.",
        });
      } else if (snap.soc <= s.alertSocLowPct && snap.batteryStatus === "discharging") {
        await this.fire({
          rule: "socLow",
          severity: "warning",
          title: `Battery low (${snap.soc}%)`,
          body: `Below the ${s.alertSocLowPct}% threshold and discharging.`,
        });
      }
      if (snap.soc >= 100 && snap.batteryStatus !== "discharging") {
        await this.fire({
          rule: "batteryFull",
          severity: "info",
          title: "Battery fully charged",
          body: "Surplus solar will now be exported or curtailed.",
        });
      }
    }

    const maxTemp = Math.max(snap.dcTemp ?? 0, snap.heatsinkTemp ?? 0);
    if (maxTemp >= s.alertTempHighC) {
      await this.fire({
        rule: "tempHigh",
        severity: "warning",
        title: `Inverter running hot (${maxTemp.toFixed(1)}°C)`,
        body: `Above the ${s.alertTempHighC}°C threshold. Check ventilation.`,
      });
    }

    if (snap.gridStatus !== "offline" && snap.gridV > 0) {
      if (snap.gridV < s.alertGridVLow || snap.gridV > s.alertGridVHigh) {
        await this.fire({
          rule: "gridVOutOfRange",
          severity: "warning",
          title: `Grid voltage out of range (${snap.gridV.toFixed(0)} V)`,
          body: `Outside ${s.alertGridVLow}-${s.alertGridVHigh} V.`,
        });
      }
    }
  }

  /**
   * Severe weather within the next ~48 h becomes a real alert, so it reaches
   * the notification list, the WebSocket toast and web push alike. Called by
   * the weather service after each forecast refresh.
   */
  async checkStormWarnings(warnings: WeatherWarning[], tz?: string): Promise<void> {
    const todayKey = localDateKey(new Date(), tz);
    const tomorrowKey = localDateKey(new Date(Date.now() + 86400000), tz);
    const soon = warnings.filter((w) => w.date >= todayKey && w.date <= tomorrowKey);
    if (soon.length === 0) return;
    const worst = [...soon].sort((a, b) =>
      a.severity === b.severity ? a.date.localeCompare(b.date) : a.severity === "critical" ? -1 : 1,
    )[0];
    await this.fire({
      rule: "stormWarning",
      severity: worst.severity === "critical" ? "critical" : "warning",
      title: worst.title,
      body: `${worst.text} Consider charging the battery to full before it hits.`,
    });
  }

  /** Yesterday's PV vs its forecast (called by the daily calibration job). */
  async checkPvUnderperformance(actualKwh: number, forecastKwh: number): Promise<void> {
    if (forecastKwh < 2) return;
    if (actualKwh < forecastKwh * PV_UNDERPERFORMANCE_FACTOR) {
      await this.fire({
        rule: "pvUnderperforming",
        severity: "warning",
        title: "PV underperforming",
        body: `Produced ${actualKwh.toFixed(1)} kWh vs ~${forecastKwh.toFixed(1)} kWh expected. Panels dirty or shaded?`,
      });
    }
  }

  private async fire(alert: FiredAlert): Promise<void> {
    const cooldown = COOLDOWN_MS[alert.rule] ?? 15 * 60000;
    const last = this.lastFired.get(alert.rule) ?? 0;
    const now = Date.now();
    if (now - last < cooldown) return;
    this.lastFired.set(alert.rule, now);

    const [row] = await this.db
      .insert(notifications)
      .values({
        environmentId: this.environmentId,
        rule: alert.rule,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
      })
      .returning({ id: notifications.id, ts: notifications.ts });

    this.liveState.emitAlert({
      id: row.id,
      rule: alert.rule,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      ts: row.ts.toISOString(),
    });
  }
}
