import { eq, isNull, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { environments } from "../db/schema.js";
import type { CapabilityOverrides } from "../config.js";
import { DeyeInverter } from "../inverter/reader.js";
import { createSimulatedControl, InverterControl } from "../inverter/control.js";
import { SimulatedRegisterTransport } from "../inverter/registerImage.js";
import { SimulatedInverter } from "../inverter/simulator.js";
import type { InverterSource } from "../inverter/types.js";
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
  /**
   * Who attached each polling serial (gateway session / agent session).
   * Detaches name their owner, so a stale close from a replaced connection
   * can never stop the polling a newer connection started (the "agent says
   * Connected but data stopped" race).
   */
  private readonly attachOwners = new Map<number, unknown>();

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
          this.makeSimulator(row, rt),
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

  private makeSimulator(row: EnvironmentRow, rt: EnvironmentRuntime): InverterSource {
    const s = rt.settings.get();
    const sim = new SimulatedInverter({
      kwp: s.pvKwp,
      batteryCapacityKwh: s.batteryCapacityKwh,
      phases: row.inverterConfig?.phases ?? 1,
    });
    // 3-phase demos take the full production path: the simulator is projected
    // onto the raw 3-phase register bank and read back through the very same
    // register-map code (DeyeInverter) that real hardware uses.
    if (row.inverterConfig?.phases === 3) {
      const transport = new SimulatedRegisterTransport(sim, {
        phases: 3,
        hv: row.inverterConfig.hv ?? false,
      });
      return new DeyeInverter(transport, row.inverterConfig, rt.inverterMutex);
    }
    return sim;
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
    return this.attachTransport(row, transport, transport);
  }

  /**
   * A Helio Agent reported a reachable stick. Attach it to the environment
   * that uses exactly this agent + serial pair, if any. `owner` identifies
   * the agent session so stale detaches can be ignored.
   */
  async attachAgentStick(
    agentId: string,
    serial: number,
    transport: WritableRegisterTransport,
    owner: unknown = transport,
  ): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.loggerSerial, serial), isNull(environments.deletedAt)));
    const row = rows[0];
    if (!row || row.sourceType !== "agent" || row.agentId !== agentId) return false;
    return this.attachTransport(row, transport, owner);
  }

  /**
   * True when a runtime is actively polling this serial — and, when `owner`
   * is given, polling through that owner. Used by the hub's reconciliation
   * to make repeated stick reports idempotent (no needless re-attach) while
   * still recovering from failed attaches and wrongful detaches.
   */
  async isAttached(serial: number, owner?: unknown): Promise<boolean> {
    for (const [, promise] of this.runtimes) {
      const rt = await promise.catch(() => null);
      if (rt && rt.env.loggerSerial === serial) {
        if (!rt.polling) return false;
        return owner === undefined || this.attachOwners.get(serial) === owner;
      }
    }
    return false;
  }

  private async attachTransport(
    row: EnvironmentRow,
    transport: WritableRegisterTransport,
    owner: unknown,
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
    this.attachOwners.set(row.loggerSerial!, owner);
    return true;
  }

  /**
   * The stick's connection (gateway or agent) dropped: stop polling.
   * When `owner` is given, only detach if that owner still holds the
   * attachment — a close event from an already-replaced connection must not
   * stop the polling its replacement started.
   */
  async detachSerial(serial: number, owner?: unknown): Promise<void> {
    if (owner !== undefined && this.attachOwners.get(serial) !== owner) return;
    for (const [, promise] of this.runtimes) {
      const rt = await promise.catch(() => null);
      if (rt && rt.env.loggerSerial === serial) {
        this.attachOwners.delete(serial);
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
    this.attachOwners.delete(serial);
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
