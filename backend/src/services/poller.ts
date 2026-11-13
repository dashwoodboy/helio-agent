import type { InverterConfig, InverterSource, LiveReading } from "../inverter/types.js";
import { computeFlows } from "./flows.js";
import { estimateChargeTime, PowerWindow } from "./chargeEta.js";
import type { LiveState } from "./liveState.js";
import type { Recorder } from "./recorder.js";
import type { GeneratorTracker, OutageTracker } from "./trackers.js";
import type { SettingsService } from "./settings.js";

export interface PollerOptions {
  pollIntervalMs: number;
  fullPollIntervalMs: number;
}

/**
 * Drives the inverter reads: a fast live read on every tick and a full
 * read (temps, daily counters) once per fullPollIntervalMs. Feeds the
 * LiveState, Recorder and trackers.
 */
export class Poller {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastFullMs = 0;
  private lastPruneMs = 0;
  private consecutiveFailures = 0;
  private readonly chargeWindow = new PowerWindow(24);

  constructor(
    private readonly source: InverterSource,
    private readonly config: InverterConfig,
    private readonly liveState: LiveState,
    private readonly recorder: Recorder,
    private readonly outageTracker: OutageTracker,
    private readonly generatorTracker: GeneratorTracker,
    private readonly settings: SettingsService,
    private readonly opts: PollerOptions,
    private readonly log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } = console,
  ) {
    this.liveState.config = config;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    const started = Date.now();
    try {
      await this.tick();
      if (this.consecutiveFailures >= 3) this.log.info("Inverter back online");
      this.consecutiveFailures = 0;
    } catch (err) {
      this.liveState.recordFailure();
      this.consecutiveFailures++;
      // Log the first failure and then every 10th, to avoid log spam while offline.
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
        this.log.warn(
          `Inverter poll failed (${this.consecutiveFailures}x): ${(err as Error).message}`,
        );
      }
    }
    if (this.stopped) return;
    const elapsed = Date.now() - started;
    // The environment's own refresh setting wins over the server default and
    // is re-read every tick, so changes apply without a restart.
    const pollIntervalS = this.settings.get().pollIntervalS;
    const baseMs =
      pollIntervalS != null
        ? Math.max(2000, pollIntervalS * 1000)
        : this.opts.pollIntervalMs;
    // Exponential backoff while the inverter is unreachable (caps at 2 min).
    const backoff =
      this.consecutiveFailures > 2
        ? Math.min(baseMs * 2 ** Math.min(this.consecutiveFailures - 2, 5), 120000)
        : baseMs;
    const wait = Math.max(250, backoff - elapsed);
    this.timer = setTimeout(() => void this.loop(), wait);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const isFull = now - this.lastFullMs >= this.opts.fullPollIntervalMs;

    if (isFull) {
      const full = await this.source.readFull(this.config);
      this.lastFullMs = now;
      this.publish(full, true);
      await this.recorder.onFullRead(full);
      await this.afterSample(full);
    } else {
      const live = await this.source.readLive(this.config);
      this.publish(live, false);
      await this.recorder.onSample(live);
      await this.afterSample(live);
    }

    // Prune old telemetry once a day.
    if (now - this.lastPruneMs > 86400000) {
      this.lastPruneMs = now;
      await this.recorder.pruneTelemetry();
    }
  }

  private async afterSample(reading: LiveReading): Promise<void> {
    await this.outageTracker.onSample(reading);
    if (this.config.hasGenerator) {
      await this.generatorTracker.onSample(reading);
    }
  }

  private publish(reading: LiveReading, isFull: boolean): void {
    const flows = computeFlows(reading);
    const s = this.settings.get();

    this.chargeWindow.add(reading.battW);
    const smoothedPower = this.chargeWindow.average() ?? reading.battW;
    const chargeEstimate = this.config.hasBattery
      ? estimateChargeTime(reading.soc, smoothedPower, s.batteryCapacityKwh, s.batteryMinSocPct)
      : null;

    const today = this.recorder.todayFlowsKwh();
    const selfSufficiencyPct =
      today.loadKwh > 0.05
        ? Math.min(100, Math.round(((today.pvToLoadKwh + today.battToLoadKwh) / today.loadKwh) * 100))
        : null;
    const selfConsumptionPct =
      today.pvKwh > 0.05
        ? Math.min(100, Math.round(((today.pvToLoadKwh + today.pvToBattKwh) / today.pvKwh) * 100))
        : null;

    const extras = { flows, chargeEstimate, selfSufficiencyPct, selfConsumptionPct };
    if (isFull) {
      this.liveState.updateFull(reading as never, extras);
    } else {
      this.liveState.updateLive(reading, extras);
    }
  }
}
