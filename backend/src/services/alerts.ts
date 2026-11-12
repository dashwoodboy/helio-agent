import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notifications } from "../db/schema.js";
import { localDateKey, zonedDayStart } from "../lib/time.js";
import { fmtTemp } from "../lib/units.js";
import { AlertDeduper, DAY_DEDUPED_RULES, stormSignature } from "./alertDedupe.js";
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
  /** Content key for same-day dedupe (storm warnings vary by kind/severity/date). */
  signature?: string;
}

/**
 * Flap guard for event rules (grid lost/restored, generator start/stop):
 * these are exempt from the once-per-day dedupe — a second real outage in
 * the afternoon deserves its own alert — but a bouncing contact shouldn't
 * produce a burst.
 */
const EVENT_COOLDOWN_MS = 10 * 60000;

/** Alert when actual PV lands ≥30% below the (calibrated) forecast. */
export const PV_UNDERPERFORMANCE_FACTOR = 0.7;

/**
 * Evaluates alert rules on live samples and lifecycle events, stores
 * notifications and pushes them over the live WebSocket stream.
 *
 * Spam control (see alertDedupe.ts for the pure logic):
 *  - condition rules fire only on the enter transition (edge-triggered);
 *  - every condition rule fires at most once per local day, persisted via
 *    the notifications table so restarts don't repeat alerts;
 *  - storm warnings fire only when the warning changes (new/escalated/moved)
 *    and emit an info all-clear when a known warning lifts.
 */
export class AlertEngine {
  private readonly deduper = new AlertDeduper();
  private lastEventFired = new Map<string, number>();
  private evalCounter = 0;
  /** Resolves once today's notifications have been replayed into the deduper. */
  private seeded: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
    private readonly liveState: LiveState,
    private readonly settingsService: SettingsService,
    private readonly outageTracker: OutageTracker,
    private readonly generatorTracker: GeneratorTracker,
    private readonly tz?: string,
  ) {}

  private liveListener: ((snap: LiveSnapshot) => void) | null = null;

  start(): void {
    this.seeded = this.seedFromDb().catch(() => undefined);

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

  /**
   * Replay today's notifications into the deduper so a process restart does
   * not re-send alerts that already went out earlier in the day.
   */
  private async seedFromDb(): Promise<void> {
    const todayKey = localDateKey(new Date(), this.tz);
    const rows = await this.db
      .select({ rule: notifications.rule, signature: notifications.signature, ts: notifications.ts })
      .from(notifications)
      .where(
        and(
          eq(notifications.environmentId, this.environmentId),
          gte(notifications.ts, zonedDayStart(todayKey, this.tz)),
        ),
      );
    let lastStorm: { ts: Date; signature: string | null } | null = null;
    for (const row of rows) {
      this.deduper.markFired(row.rule, todayKey, row.signature);
      if (row.rule === "stormWarning" || row.rule === "stormCleared") {
        if (!lastStorm || row.ts > lastStorm.ts) {
          lastStorm = {
            ts: row.ts,
            signature: row.rule === "stormWarning" ? row.signature : null,
          };
        }
      }
    }
    // Remember the storm the user already knows about, so an unchanged
    // forecast stays quiet and a passed storm still gets its all-clear.
    if (lastStorm) this.deduper.seedSignature("stormWarning", lastStorm.signature);
  }

  private async evaluate(snap: LiveSnapshot): Promise<void> {
    const s = this.settingsService.get();
    if (!s.alertsEnabled) return;

    // Offline transition
    if (this.deduper.transition("inverterOffline", !snap.online)) {
      await this.fire({
        rule: "inverterOffline",
        severity: "warning",
        title: "Inverter unreachable",
        body: "No successful reads from the inverter for several polls.",
      });
    }
    if (!snap.online) return;

    const hasBattery = this.liveState.config?.hasBattery ?? true;
    const socKnown = hasBattery && snap.soc > 0;
    const socCritical = socKnown && snap.soc <= Math.max(5, s.alertSocLowPct - 10);
    const socLow =
      socKnown && !socCritical && snap.soc <= s.alertSocLowPct && snap.batteryStatus === "discharging";
    const batteryFull = socKnown && snap.soc >= 100 && snap.batteryStatus !== "discharging";

    if (this.deduper.transition("socCritical", socCritical)) {
      await this.fire({
        rule: "socCritical",
        severity: "critical",
        title: `Battery critically low (${snap.soc}%)`,
        body: "Consider reducing load or starting a backup source.",
      });
    }
    if (this.deduper.transition("socLow", socLow)) {
      await this.fire({
        rule: "socLow",
        severity: "warning",
        title: `Battery low (${snap.soc}%)`,
        body: `Below the ${s.alertSocLowPct}% threshold and discharging.`,
      });
    }
    if (this.deduper.transition("batteryFull", batteryFull)) {
      await this.fire({
        rule: "batteryFull",
        severity: "info",
        title: "Battery fully charged",
        body: "Surplus solar will now be exported or curtailed.",
      });
    }

    const maxTemp = Math.max(snap.dcTemp ?? 0, snap.heatsinkTemp ?? 0);
    if (this.deduper.transition("tempHigh", maxTemp >= s.alertTempHighC)) {
      await this.fire({
        rule: "tempHigh",
        severity: "warning",
        title: `Inverter running hot (${fmtTemp(maxTemp, s.units)})`,
        body: `Above the ${fmtTemp(s.alertTempHighC, s.units, 0)} threshold. Check ventilation.`,
      });
    }

    const gridConnected = snap.gridStatus !== "offline" && snap.gridV > 0;
    const gridVBad = gridConnected && (snap.gridV < s.alertGridVLow || snap.gridV > s.alertGridVHigh);
    if (this.deduper.transition("gridVOutOfRange", gridVBad)) {
      await this.fire({
        rule: "gridVOutOfRange",
        severity: "warning",
        title: `Grid voltage out of range (${snap.gridV.toFixed(0)} V)`,
        body: `Outside ${s.alertGridVLow}-${s.alertGridVHigh} V.`,
      });
    }
  }

  /**
   * Severe weather within the next ~48 h becomes a real alert, so it reaches
   * the notification list, the WebSocket toast and web push alike. Called by
   * the weather service after each forecast refresh. Fires only when the
   * warning changes (new, escalated or shifted to another day) and sends an
   * info all-clear when a previously-announced warning lifts.
   */
  async checkStormWarnings(warnings: WeatherWarning[], tz?: string): Promise<void> {
    await this.seeded;
    const effectiveTz = tz ?? this.tz;
    const todayKey = localDateKey(new Date(), effectiveTz);
    const tomorrowKey = localDateKey(new Date(Date.now() + 86400000), effectiveTz);
    const { signature, worst } = stormSignature(warnings, todayKey, tomorrowKey);
    const change = this.deduper.updateSignature("stormWarning", signature);

    if (change.changed && worst && signature) {
      await this.fire({
        rule: "stormWarning",
        severity: worst.severity === "critical" ? "critical" : "warning",
        title: worst.title,
        body: `${worst.text} Consider charging the battery to full before it hits.`,
        signature,
      });
    } else if (change.cleared) {
      await this.fire({
        rule: "stormCleared",
        severity: "info",
        title: "Severe weather warning lifted",
        body: "The earlier weather warning is no longer in effect.",
      });
    }
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
    await this.seeded;
    const signature = alert.signature ?? "";

    if (DAY_DEDUPED_RULES.has(alert.rule)) {
      const todayKey = localDateKey(new Date(), this.tz);
      if (!this.deduper.shouldFire(alert.rule, todayKey, signature)) return;
      this.deduper.markFired(alert.rule, todayKey, signature);
    } else {
      const last = this.lastEventFired.get(alert.rule) ?? 0;
      const now = Date.now();
      if (now - last < EVENT_COOLDOWN_MS) return;
      this.lastEventFired.set(alert.rule, now);
    }

    const [row] = await this.db
      .insert(notifications)
      .values({
        environmentId: this.environmentId,
        rule: alert.rule,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        signature,
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
