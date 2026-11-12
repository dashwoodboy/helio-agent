import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { generatorSessions, outageEvents } from "../db/schema.js";
import type { LiveReading } from "../inverter/types.js";

const OUTAGE_V_THRESHOLD = 80;
const RESTORE_V_THRESHOLD = 180;
/** Consecutive samples required to flip state (debounce). */
const DEBOUNCE_SAMPLES = 3;

export interface OutageStatus {
  active: boolean;
  startedAt: string | null;
  minSoc: number | null;
}

export class OutageTracker {
  private counter = 0;
  private active = false;
  private currentId: number | null = null;
  private startedAt: Date | null = null;
  private minSoc: number | null = null;

  onStart: ((startedAt: Date) => void) | null = null;
  onEnd: ((startedAt: Date, endedAt: Date, durationS: number) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Resume an unclosed outage after a restart. */
  async init(): Promise<void> {
    const open = await this.db
      .select()
      .from(outageEvents)
      .where(and(eq(outageEvents.environmentId, this.environmentId), isNull(outageEvents.endedAt)))
      .orderBy(desc(outageEvents.startedAt))
      .limit(1);
    if (open.length > 0) {
      this.active = true;
      this.currentId = open[0].id;
      this.startedAt = open[0].startedAt;
      this.minSoc = open[0].minSoc;
    }
  }

  get status(): OutageStatus {
    return {
      active: this.active,
      startedAt: this.startedAt?.toISOString() ?? null,
      minSoc: this.minSoc,
    };
  }

  async onSample(reading: LiveReading): Promise<void> {
    const gridDown = reading.gridV < OUTAGE_V_THRESHOLD;

    if (this.active && reading.soc > 0) {
      this.minSoc = this.minSoc === null ? reading.soc : Math.min(this.minSoc, reading.soc);
    }

    if (gridDown === this.active) {
      this.counter = 0;
      return;
    }
    this.counter++;
    if (this.counter < DEBOUNCE_SAMPLES) return;
    this.counter = 0;

    if (gridDown) {
      this.active = true;
      this.startedAt = this.now();
      this.minSoc = reading.soc > 0 ? reading.soc : null;
      const [row] = await this.db
        .insert(outageEvents)
        .values({ environmentId: this.environmentId, startedAt: this.startedAt, minSoc: this.minSoc })
        .returning({ id: outageEvents.id });
      this.currentId = row.id;
      this.onStart?.(this.startedAt);
    } else {
      this.active = false;
      const endedAt = this.now();
      const startedAt = this.startedAt ?? endedAt;
      const durationS = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
      if (this.currentId !== null) {
        await this.db
          .update(outageEvents)
          .set({ endedAt, durationS, minSoc: this.minSoc })
          .where(eq(outageEvents.id, this.currentId));
      }
      this.onEnd?.(startedAt, endedAt, durationS);
      this.currentId = null;
      this.startedAt = null;
      this.minSoc = null;
    }
  }
}

const GEN_ON_W = 50;

export class GeneratorTracker {
  private counter = 0;
  private running = false;
  private currentId: number | null = null;
  private startedAt: Date | null = null;
  private energyWh = 0;
  private lastSampleMs: number | null = null;

  onStart: (() => void) | null = null;
  onStop: ((runtimeS: number) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async init(): Promise<void> {
    const open = await this.db
      .select()
      .from(generatorSessions)
      .where(
        and(eq(generatorSessions.environmentId, this.environmentId), isNull(generatorSessions.endedAt)),
      )
      .orderBy(desc(generatorSessions.startedAt))
      .limit(1);
    if (open.length > 0) {
      this.running = true;
      this.currentId = open[0].id;
      this.startedAt = open[0].startedAt;
      this.energyWh = open[0].energyKwh * 1000;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentSession(): { startedAt: string; energyKwh: number } | null {
    if (!this.running || !this.startedAt) return null;
    return {
      startedAt: this.startedAt.toISOString(),
      energyKwh: Math.round(this.energyWh) / 1000,
    };
  }

  async onSample(reading: LiveReading): Promise<void> {
    const nowMs = this.now().getTime();
    const on = reading.genW > GEN_ON_W;

    if (this.running && this.lastSampleMs !== null) {
      const dtS = Math.min(60, (nowMs - this.lastSampleMs) / 1000);
      this.energyWh += (reading.genW * dtS) / 3600;
    }
    this.lastSampleMs = nowMs;

    if (on === this.running) {
      this.counter = 0;
      return;
    }
    this.counter++;
    if (this.counter < DEBOUNCE_SAMPLES) return;
    this.counter = 0;

    if (on) {
      this.running = true;
      this.startedAt = this.now();
      this.energyWh = 0;
      const [row] = await this.db
        .insert(generatorSessions)
        .values({ environmentId: this.environmentId, startedAt: this.startedAt })
        .returning({ id: generatorSessions.id });
      this.currentId = row.id;
      this.onStart?.();
    } else {
      this.running = false;
      const endedAt = this.now();
      const startedAt = this.startedAt ?? endedAt;
      const runtimeS = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
      const energyKwh = Math.round(this.energyWh) / 1000;
      if (this.currentId !== null) {
        await this.db
          .update(generatorSessions)
          .set({
            endedAt,
            runtimeS,
            energyKwh,
            avgW: runtimeS > 0 ? Math.round((this.energyWh * 3600) / runtimeS) : null,
          })
          .where(eq(generatorSessions.id, this.currentId));
      }
      this.onStop?.(runtimeS);
      this.currentId = null;
      this.startedAt = null;
    }
  }
}
