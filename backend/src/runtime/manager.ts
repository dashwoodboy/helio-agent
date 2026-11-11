import { eq, isNull, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { environments } from "../db/schema.js";
import type { CapabilityOverrides } from "../config.js";
import { DeyeInverter } from "../inverter/reader.js";
import { createSimulatedControl, InverterControl } from "../inverter/control.js";
import { SimulatedInverter } from "../inverter/simulator.js";
import { SolarmanClient } from "../solarman/client.js";
import type { WritableRegisterTransport } from "../solarman/transport.js";
import type { PollerOptions } from "../services/poller.js";
import { EnvironmentRuntime, type EnvironmentRow, type RuntimeLogger } from "./environment.js";

/** Simulator environments with no viewers stop polling after this long. */
const SIM_IDLE_MS = 10 * 60000;

/**
 * Registry of per-environment runtimes. Runtimes start lazily on first API
 * access; polling lifecycles depend on the source type:
 *  - gateway: polls while the stick's inbound connection is attached
 *  - direct: polls permanently (bootstrap/legacy environments only)
 *  - simulator: polls while there are viewers, stops when idle
 */
export class RuntimeManager {
  private runtimes = new Map<string, Promise<EnvironmentRuntime>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: RuntimeLogger,
    private readonly pollOpts: PollerOptions,
  ) {}

  /** Start always-on (direct) environments and the idle sweep. */
  async start(): Promise<void> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.sourceType, "direct"), isNull(environments.deletedAt)));
    for (const row of rows) {
      try {
        await this.get(row.id);
      } catch (err) {
        this.log.warn(`Failed to start environment ${row.id}: ${(err as Error).message}`);
      }
    }
    this.sweepTimer = setInterval(() => void this.sweepIdle(), 60000);
  }

  async getEnvRow(envId: string): Promise<EnvironmentRow | null> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, envId), isNull(environments.deletedAt)));
    return rows[0] ?? null;
  }

  /** Get (lazily creating) the runtime for an environment; null when missing. */
  async get(envId: string): Promise<EnvironmentRuntime | null> {
    const existing = this.runtimes.get(envId);
    if (existing) return existing;

    const row = await this.getEnvRow(envId);
    if (!row) return null;

    const creation = (async () => {
      const rt = await EnvironmentRuntime.create(this.db, row, this.log);
      // Simulator + direct sources start immediately; gateway waits for the stick.
      if (row.sourceType === "simulator") {
        await rt.startPolling(
          this.makeSimulator(rt),
          this.pollOpts,
          createSimulatedControl(rt.inverterMutex),
        );
      } else if (row.sourceType === "direct" && row.inverterIp && row.loggerSerial) {
        const client = new SolarmanClient({
          address: row.inverterIp,
          serial: row.loggerSerial,
          port: row.inverterPort ?? 8899,
        });
        await rt.startPolling(
          this.makeReader(client, row, rt),
          this.pollOpts,
          new InverterControl(client, rt.inverterMutex),
        );
      }
      return rt;
    })();
    this.runtimes.set(envId, creation);
    try {
      return await creation;
    } catch (err) {
      this.runtimes.delete(envId);
      throw err;
    }
  }

  private makeSimulator(rt: EnvironmentRuntime): SimulatedInverter {
    const s = rt.settings.get();
    return new SimulatedInverter({ kwp: s.pvKwp, batteryCapacityKwh: s.batteryCapacityKwh });
  }

  private makeReader(
    transport: WritableRegisterTransport,
    row: EnvironmentRow,
    rt: EnvironmentRuntime,
  ): DeyeInverter {
    const overrides: CapabilityOverrides = row.inverterConfig ?? {};
    return new DeyeInverter(transport, overrides, rt.inverterMutex);
  }

  /**
   * A stick connected to the gateway. Attach it to the environment that
   * claimed its serial. Returns true when the serial is claimed.
   */
  async attachLogger(serial: number, transport: WritableRegisterTransport): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.loggerSerial, serial), isNull(environments.deletedAt)));
    const row = rows[0];
    if (!row || row.sourceType !== "gateway") return false;
    return this.attachTransport(row, transport);
  }

  /**
   * A Helio Agent reported a reachable stick. Attach it to the environment
   * that uses exactly this agent + serial pair, if any.
   */
  async attachAgentStick(
    agentId: string,
    serial: number,
    transport: WritableRegisterTransport,
  ): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.loggerSerial, serial), isNull(environments.deletedAt)));
    const row = rows[0];
    if (!row || row.sourceType !== "agent" || row.agentId !== agentId) return false;
    return this.attachTransport(row, transport);
  }

  private async attachTransport(
    row: EnvironmentRow,
    transport: WritableRegisterTransport,
  ): Promise<boolean> {
    const rt = await this.get(row.id);
    if (!rt) return false;
    await this.db
      .update(environments)
      .set({ loggerLastSeenAt: new Date() })
      .where(eq(environments.id, row.id));
    rt.env = { ...rt.env, loggerLastSeenAt: new Date() };
    await rt.startPolling(
      this.makeReader(transport, row, rt),
      this.pollOpts,
      new InverterControl(transport, rt.inverterMutex),
    );
    return true;
  }

  /** The stick's connection (gateway or agent) dropped: stop polling. */
  async detachSerial(serial: number): Promise<void> {
    for (const [, promise] of this.runtimes) {
      const rt = await promise.catch(() => null);
      if (rt && rt.env.loggerSerial === serial) {
        rt.stopPolling();
        const lastSeen = new Date();
        rt.env = { ...rt.env, loggerLastSeenAt: lastSeen };
        await this.db
          .update(environments)
          .set({ loggerLastSeenAt: lastSeen })
          .where(eq(environments.id, rt.env.id));
        return;
      }
    }
  }

  /** Drop a runtime (e.g. after PATCH/DELETE) so the next access rebuilds it. */
  async invalidate(envId: string): Promise<void> {
    const promise = this.runtimes.get(envId);
    this.runtimes.delete(envId);
    if (promise) {
      const rt = await promise.catch(() => null);
      if (rt) await rt.destroy();
    }
  }

  /** Stop simulator runtimes nobody is watching, and idle gateway runtimes. */
  private async sweepIdle(): Promise<void> {
    for (const [envId, promise] of [...this.runtimes]) {
      const rt = await promise.catch(() => null);
      if (!rt) continue;
      const idle = rt.viewers === 0 && Date.now() - rt.lastViewerAt > SIM_IDLE_MS;
      if (!idle) continue;
      if (rt.env.sourceType === "simulator") {
        this.runtimes.delete(envId);
        await rt.destroy();
        this.log.info(`[env ${envId}] simulator runtime stopped (idle)`);
      } else if (
        (rt.env.sourceType === "gateway" || rt.env.sourceType === "agent") &&
        !rt.polling
      ) {
        // No stick attached and nobody watching: free the runtime.
        this.runtimes.delete(envId);
        await rt.destroy();
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const [, promise] of this.runtimes) {
      const rt = await promise.catch(() => null);
      if (rt) await rt.destroy();
    }
    this.runtimes.clear();
  }
}
