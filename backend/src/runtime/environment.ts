import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { dailyEnergy, dailyWeather, environments } from "../db/schema.js";
import { and, sql } from "drizzle-orm";
import type { InverterConfig, InverterSource } from "../inverter/types.js";
import type { InverterControlSource } from "../inverter/control.js";
import { AsyncMutex } from "../lib/mutex.js";
import { localDateKey } from "../lib/time.js";
import { AlertEngine } from "../services/alerts.js";
import { Analytics } from "../services/analytics.js";
import { LiveState } from "../services/liveState.js";
import { MqttPublisher } from "../services/mqtt.js";
import { Poller, type PollerOptions } from "../services/poller.js";
import { PushDispatcher } from "../services/push.js";
import { Recorder } from "../services/recorder.js";
import { SettingsService } from "../services/settings.js";
import { GeneratorTracker, OutageTracker } from "../services/trackers.js";
import { WeatherService } from "../services/weather.js";

export type EnvironmentRow = typeof environments.$inferSelect;

export interface RuntimeLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
}

const DEFAULT_INVERTER_CONFIG: InverterConfig = {
  phases: 1,
  hasBattery: true,
  pvStrings: 2,
  hasGenerator: false,
};

/**
 * Everything one environment needs at runtime: its settings, live state,
 * recorder, trackers, alert engine, weather poller and (when a data source
 * is attached) the inverter poller.
 */
export class EnvironmentRuntime {
  readonly settings: SettingsService;
  readonly liveState = new LiveState();
  readonly recorder: Recorder;
  readonly outageTracker: OutageTracker;
  readonly generatorTracker: GeneratorTracker;
  readonly analytics: Analytics;
  readonly weather: WeatherService;
  readonly alertEngine: AlertEngine;
  readonly pushDispatcher: PushDispatcher;
  readonly mqtt: MqttPublisher;

  poller: Poller | null = null;
  source: InverterSource | null = null;
  /** Settings read/write channel; present while a data source is attached. */
  control: InverterControlSource | null = null;
  /** Serializes all inverter access (poller reads vs. settings operations). */
  readonly inverterMutex = new AsyncMutex();
  inverterConfig: InverterConfig;

  /** Open WebSocket viewers, maintained by the ws layer. */
  viewers = 0;
  lastViewerAt = Date.now();

  private calibrationTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  private constructor(
    private readonly db: Db,
    public env: EnvironmentRow,
    private readonly log: RuntimeLogger,
  ) {
    const tz = env.timezone || undefined;
    this.settings = new SettingsService(db, env.id);
    this.weather = new WeatherService(db, this.settings, env.id, env.lat, env.lon, tz);
    this.recorder = new Recorder(db, this.settings, env.id, tz);
    this.outageTracker = new OutageTracker(db, env.id);
    this.generatorTracker = new GeneratorTracker(db, env.id);
    this.analytics = new Analytics(db, env.id, tz);
    this.alertEngine = new AlertEngine(
      db, env.id, this.liveState, this.settings, this.outageTracker, this.generatorTracker, tz,
    );
    this.pushDispatcher = new PushDispatcher(db, env.id, this.liveState, log);
    this.mqtt = new MqttPublisher(env.id, env.name, this.liveState, log);
    // Severe weather becomes a regular alert (list + WebSocket + push).
    this.weather.onWarnings = (warnings) => {
      void this.alertEngine.checkStormWarnings(warnings, tz).catch(() => undefined);
    };
    this.inverterConfig = env.inverterConfig ?? DEFAULT_INVERTER_CONFIG;
    this.liveState.config = this.inverterConfig;
  }

  get tz(): string | undefined {
    return this.env.timezone || undefined;
  }

  static async create(db: Db, env: EnvironmentRow, log: RuntimeLogger): Promise<EnvironmentRuntime> {
    const rt = new EnvironmentRuntime(db, env, log);
    await rt.settings.load();
    await rt.recorder.init();
    await rt.outageTracker.init();
    await rt.generatorTracker.init();
    rt.alertEngine.start();
    rt.pushDispatcher.start();
    rt.mqtt.apply(rt.settings.get());
    rt.weather.start();
    // Nightly-ish job: backfill yesterday's actual PV into daily_weather
    // (forecast calibration input).
    rt.calibrationTimer = setInterval(() => void rt.calibrationBackfill(), 3600000);
    return rt;
  }

  get polling(): boolean {
    return this.poller !== null;
  }

  /**
   * Attach a data source and start polling. Detects capabilities (cached in
   * the environments row across restarts) before the first poll.
   */
  async startPolling(
    source: InverterSource,
    opts: PollerOptions,
    control: InverterControlSource | null = null,
  ): Promise<void> {
    if (this.destroyed) return;
    this.stopPolling();
    this.source = source;
    this.control = control;

    try {
      this.inverterConfig = await source.detectConfig();
      if (JSON.stringify(this.env.inverterConfig) !== JSON.stringify(this.inverterConfig)) {
        await this.db
          .update(environments)
          .set({ inverterConfig: this.inverterConfig })
          .where(eq(environments.id, this.env.id));
        this.env = { ...this.env, inverterConfig: this.inverterConfig };
      }
    } catch (err) {
      this.log.warn(
        `[env ${this.env.id}] capability detect failed (${(err as Error).message}); ` +
          `using ${this.env.inverterConfig ? "cached" : "default"} config`,
      );
      this.inverterConfig = this.env.inverterConfig ?? DEFAULT_INVERTER_CONFIG;
    }

    this.poller = new Poller(
      source,
      this.inverterConfig,
      this.liveState,
      this.recorder,
      this.outageTracker,
      this.generatorTracker,
      this.settings,
      opts,
      this.log,
    );
    this.poller.start();
    this.log.info(`[env ${this.env.id}] polling started (${this.env.sourceType})`);
  }

  stopPolling(): void {
    if (this.poller) {
      this.poller.stop();
      this.poller = null;
      this.liveState.markOffline();
      this.log.info(`[env ${this.env.id}] polling stopped`);
    }
    if (this.source) {
      void this.source.close().catch(() => undefined);
      this.source = null;
    }
    this.control = null;
  }

  addViewer(): void {
    this.viewers++;
    this.lastViewerAt = Date.now();
  }

  removeViewer(): void {
    this.viewers = Math.max(0, this.viewers - 1);
    this.lastViewerAt = Date.now();
  }

  private async calibrationBackfill(): Promise<void> {
    try {
      const yesterday = localDateKey(new Date(Date.now() - 86400000), this.tz);
      const rows = await this.db
        .select()
        .from(dailyEnergy)
        .where(and(eq(dailyEnergy.environmentId, this.env.id), eq(dailyEnergy.date, yesterday)));
      if (rows.length > 0) {
        const updated = await this.db
          .update(dailyWeather)
          .set({ actualPvKwh: rows[0].pvKwh })
          .where(
            sql`${dailyWeather.environmentId} = ${this.env.id} AND ${dailyWeather.date} = ${yesterday} AND ${dailyWeather.actualPvKwh} IS NULL`,
          )
          .returning({ forecastPvKwh: dailyWeather.forecastPvKwh });
        // The IS NULL guard means this runs exactly once per day — the right
        // moment to judge yesterday against its forecast.
        if (updated.length > 0 && updated[0].forecastPvKwh !== null) {
          await this.alertEngine.checkPvUnderperformance(rows[0].pvKwh, updated[0].forecastPvKwh);
        }
      }
    } catch (err) {
      this.log.warn(`[env ${this.env.id}] calibration backfill failed: ${(err as Error).message}`);
    }
  }

  private readonly destroyListeners = new Set<() => void>();

  /**
   * Runs `fn` when this runtime is torn down (the environment was reconfigured
   * or deleted). Live sockets use it to close so their client reconnects and
   * gets bound to the replacement runtime instead of going quietly stale.
   * Returns an unsubscribe function.
   */
  onDestroy(fn: () => void): () => void {
    this.destroyListeners.add(fn);
    return () => this.destroyListeners.delete(fn);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const fn of [...this.destroyListeners]) {
      try {
        fn();
      } catch {
        /* a listener must not block teardown */
      }
    }
    this.destroyListeners.clear();
    this.stopPolling();
    this.weather.stop();
    this.alertEngine.stop();
    this.pushDispatcher.stop();
    this.mqtt.stop();
    if (this.calibrationTimer) clearInterval(this.calibrationTimer);
    // Persist whatever the recorder has buffered for today.
    try {
      await this.recorder.flushDaily();
    } catch {
      /* best effort on shutdown */
    }
  }
}
