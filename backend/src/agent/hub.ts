import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import type { WebSocket } from "ws";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, environments, type AgentRow } from "../db/schema.js";
import type { RuntimeManager } from "../runtime/manager.js";
import { hashAgentToken } from "./pairing.js";
import { AgentStickTransport } from "./transport.js";

/** Bump when the WS message shape changes incompatibly. */
export const AGENT_PROTOCOL_VERSION = 1;

/** Close codes the agent understands. */
export const AGENT_CLOSE_UNAUTHORIZED = 4401;
export const AGENT_CLOSE_PROTOCOL = 4426;
export const AGENT_CLOSE_REPLACED = 4409;
export const AGENT_CLOSE_REVOKED = 4403;

const RPC_TIMEOUT_MS = 15000;
const HELLO_TIMEOUT_MS = 5000;
/** Messages allowed per session per 10 s (results + stick reports). */
const MESSAGE_BUDGET = 400;
/** Ping cadence; a session missing 2 pongs in a row (~65 s) is dead. */
const PING_INTERVAL_MS = 30000;
const MAX_MISSED_PONGS = 2;

export interface AgentStick {
  serial: number | null;
  ip: string;
  mac: string | null;
  reachable: boolean;
}

const stickSchema = z.object({
  serial: z.number().int().min(1).max(0xffffffff).nullable(),
  ip: z.string().max(45),
  mac: z.string().max(23).nullable(),
  reachable: z.boolean(),
});

const agentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.number().int(),
    version: z.string().max(40),
    platform: z.string().max(20),
    name: z.string().max(60),
  }),
  z.object({ type: z.literal("sticks"), sticks: z.array(stickSchema).max(32) }),
  z.object({
    type: z.literal("result"),
    id: z.string().max(40),
    ok: z.boolean(),
    values: z.array(z.number().int().min(0).max(0xffff)).max(125).optional(),
    error: z.string().max(300).optional(),
  }),
]);

type AgentMessage = z.infer<typeof agentMessageSchema>;

export interface AgentRpcRequest {
  serial: number;
  op: "read" | "write1" | "writeN";
  addr: number;
  quantity?: number;
  value?: number;
  values?: number[];
}

interface PendingRpc {
  resolve: (values: number[] | undefined) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class AgentRpcError extends Error {}

type HubLog = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

/** One connected agent. */
class AgentSession {
  sticks: AgentStick[] = [];
  version = "";
  private readonly pending = new Map<string, PendingRpc>();
  /** One request in flight per stick serial. */
  private readonly chains = new Map<number, Promise<unknown>>();
  private messageTimestamps: number[] = [];
  closed = false;

  constructor(
    readonly agent: AgentRow,
    private readonly socket: WebSocket,
    private readonly log: HubLog,
  ) {}

  /** True while staying under the message-rate budget. */
  admitMessage(): boolean {
    const now = Date.now();
    this.messageTimestamps = this.messageTimestamps.filter((t) => now - t < 10000);
    this.messageTimestamps.push(now);
    return this.messageTimestamps.length <= MESSAGE_BUDGET;
  }

  send(payload: unknown): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AgentRpcError(`Agent disconnected (${reason})`));
    }
    this.pending.clear();
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  onResult(msg: Extract<AgentMessage, { type: "result" }>): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.values);
    else p.reject(new AgentRpcError(msg.error ?? "agent error"));
  }

  /** Send one RPC, serialized per stick, and await the agent's result. */
  rpc(req: AgentRpcRequest): Promise<number[] | undefined> {
    const prev = this.chains.get(req.serial) ?? Promise.resolve();
    const run = prev.then(() => this.doRpc(req));
    this.chains.set(req.serial, run.catch(() => undefined));
    return run;
  }

  private doRpc(req: AgentRpcRequest): Promise<number[] | undefined> {
    if (this.closed) return Promise.reject(new AgentRpcError("Agent is not connected"));
    const id = randomUUID();
    return new Promise<number[] | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentRpcError(`Timeout awaiting agent response (${req.op} ${req.addr})`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "rpc", id, ...req });
    });
  }
}

/**
 * Registry of connected Helio Agents. Authenticates the WebSocket by the
 * bearer token in the upgrade request, tracks each agent's discovered sticks,
 * and attaches/detaches environment runtimes as claimed sticks come and go —
 * the agent-mode counterpart of LoggerGateway.
 */
export class AgentHub {
  private readonly sessions = new Map<string, AgentSession>(); // agentId → session
  private readonly pingIntervalMs: number;

  constructor(
    private readonly db: Db,
    private readonly manager: RuntimeManager,
    private readonly log: HubLog,
    opts: { pingIntervalMs?: number } = {},
  ) {
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  }

  isOnline(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  sticksFor(agentId: string): AgentStick[] {
    return this.sessions.get(agentId)?.sticks ?? [];
  }

  /**
   * A stick with an unknown serial (UDP probe unanswered — manual entries,
   * TCP-sweep finds) still counts as a candidate: the user supplies the label
   * serial, the agent tries it, and the stick only answers when it matches —
   * at which point the agent adopts and reports the real serial.
   */
  hasStick(agentId: string, serial: number | null): boolean {
    if (serial === null) return false;
    return this.sticksFor(agentId).some(
      (s) => (s.serial === serial || s.serial === null) && s.reachable,
    );
  }

  /** Transport for one stick behind one agent; null when not available. */
  transportFor(agentId: string, serial: number): AgentStickTransport | null {
    const session = this.sessions.get(agentId);
    if (!session || !session.sticks.some((s) => s.serial === serial || s.serial === null)) {
      return null;
    }
    return new AgentStickTransport(session, serial);
  }

  /** Kick a revoked/deleted agent immediately. */
  disconnect(agentId: string, reason = "revoked"): void {
    const session = this.sessions.get(agentId);
    if (session) {
      this.sessions.delete(agentId);
      session.close(AGENT_CLOSE_REVOKED, reason);
    }
  }

  /** An environment switched to this agent/serial: attach if already reported. */
  async tryAttach(agentId: string, serial: number): Promise<boolean> {
    const session = this.sessions.get(agentId);
    if (!session || !session.sticks.some((s) => s.serial === serial || s.serial === null)) {
      return false;
    }
    return this.manager.attachAgentStick(
      agentId,
      serial,
      new AgentStickTransport(session, serial),
      session,
    );
  }

  async closeAll(): Promise<void> {
    for (const [id, session] of [...this.sessions]) {
      this.sessions.delete(id);
      session.close(1001, "server shutdown");
    }
  }

  /**
   * New /ws/agent connection. The upgrade request must carry
   * `Authorization: Bearer <agent token>`; the socket is dropped otherwise.
   */
  async handleSocket(
    socket: WebSocket,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    // Buffer frames that arrive while we authenticate (the agent typically
    // sends its hello immediately after the upgrade); replayed below.
    const early: Buffer[] = [];
    const buffer = (raw: Buffer) => {
      early.push(raw);
    };
    socket.on("message", buffer);

    const header = String(headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      socket.close(AGENT_CLOSE_UNAUTHORIZED, "missing token");
      return;
    }
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.tokenHash, hashAgentToken(token)), isNull(agents.revokedAt)));
    const agent = rows[0];
    if (!agent) {
      socket.close(AGENT_CLOSE_UNAUTHORIZED, "unknown token");
      return;
    }

    // A reconnect replaces the previous session.
    const previous = this.sessions.get(agent.id);
    if (previous) previous.close(AGENT_CLOSE_REPLACED, "replaced by new connection");

    const session = new AgentSession(agent, socket, this.log);
    this.sessions.set(agent.id, session);
    this.log.info(`Agent ${agent.id} (${agent.name}) connected`);

    let helloed = false;
    const helloTimer = setTimeout(() => {
      if (!helloed) this.drop(session, AGENT_CLOSE_PROTOCOL, "no hello");
    }, HELLO_TIMEOUT_MS);

    const touch = setInterval(() => {
      void this.db
        .update(agents)
        .set({ lastSeenAt: new Date() })
        .where(eq(agents.id, agent.id))
        .catch(() => undefined);
    }, 60000);

    // Heartbeat: sockets that stopped answering pings (half-open after a
    // network drop) are terminated so the close handler runs promptly
    // instead of after the OS TCP timeout.
    let missedPongs = 0;
    socket.on("pong", () => {
      missedPongs = 0;
    });

    const onMessage = (raw: Buffer) => {
      missedPongs = 0; // any traffic proves the link is alive
      if (!session.admitMessage()) {
        this.drop(session, AGENT_CLOSE_PROTOCOL, "message rate exceeded");
        return;
      }
      let msg: AgentMessage;
      try {
        msg = agentMessageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        this.drop(session, AGENT_CLOSE_PROTOCOL, "bad message");
        return;
      }
      if (!helloed) {
        if (msg.type !== "hello") {
          this.drop(session, AGENT_CLOSE_PROTOCOL, "hello expected");
          return;
        }
        if (msg.protocol !== AGENT_PROTOCOL_VERSION) {
          this.drop(session, AGENT_CLOSE_PROTOCOL, "protocol version mismatch");
          return;
        }
        helloed = true;
        clearTimeout(helloTimer);
        session.version = msg.version;
        // Additive fields only: 0.1.x agents ignore what they don't know.
        session.send({
          type: "ready",
          agentId: agent.id,
          name: agent.name,
          serverTime: new Date().toISOString(),
          latestAgentVersion: config.agentLatestVersion || null,
          minAgentVersion: config.agentMinVersion || null,
        });
        void this.db
          .update(agents)
          .set({
            lastSeenAt: new Date(),
            platform: msg.platform || agent.platform,
            version: msg.version,
          })
          .where(eq(agents.id, agent.id))
          .catch(() => undefined);
        return;
      }
      if (msg.type === "result") {
        session.onResult(msg);
      } else if (msg.type === "sticks") {
        void this.onSticks(session, msg.sticks);
      }
    };
    socket.off("message", buffer);
    socket.on("message", onMessage);
    for (const raw of early) {
      if (session.closed) break;
      onMessage(raw);
    }

    const ping = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (missedPongs >= MAX_MISSED_PONGS) {
        this.log.warn(`Agent ${agent.id}: heartbeat timeout, terminating`);
        socket.terminate(); // triggers "close" below
        return;
      }
      missedPongs++;
      socket.ping();
    }, this.pingIntervalMs);

    socket.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(ping);
      clearInterval(touch);
      if (this.sessions.get(agent.id) === session) {
        this.sessions.delete(agent.id);
        this.log.info(`Agent ${agent.id} disconnected`);
      }
      session.close(1000, "closed");
      // Owner-checked detach: when a reconnect already replaced this session
      // (4409) and re-attached the sticks, this late close must not stop the
      // new session's polling.
      void this.detachAll(session);
    });
    socket.on("error", () => socket.terminate());
  }

  private drop(session: AgentSession, code: number, reason: string): void {
    this.log.warn(`Agent ${session.agent.id}: ${reason}`);
    if (this.sessions.get(session.agent.id) === session) {
      this.sessions.delete(session.agent.id);
    }
    session.close(code, reason);
  }

  /**
   * The agent reported its current stick list. Reconciliation is idempotent:
   * every reachable stick that is not currently polling through this session
   * is (re)attached — recovering from failed attaches and wrongful detaches,
   * not just reacting to set differences. The agent re-reports at least once
   * a minute, so recovery is bounded even without changes.
   */
  private async onSticks(session: AgentSession, sticks: AgentStick[]): Promise<void> {
    const before = new Set(
      session.sticks.filter((s) => s.serial !== null && s.reachable).map((s) => s.serial as number),
    );
    session.sticks = sticks;
    const now = new Set(
      sticks.filter((s) => s.serial !== null && s.reachable).map((s) => s.serial as number),
    );

    for (const serial of now) {
      // The session may have been replaced while we awaited a previous attach.
      if (this.sessions.get(session.agent.id) !== session || session.closed) return;
      try {
        if (await this.manager.isAttached(serial, session)) continue;
        const attached = await this.manager.attachAgentStick(
          session.agent.id,
          serial,
          new AgentStickTransport(session, serial),
          session,
        );
        if (attached) this.log.info(`Agent ${session.agent.id}: stick ${serial} attached`);
      } catch (err) {
        this.log.warn(`Agent ${session.agent.id}: attach ${serial} failed: ${(err as Error).message}`);
      }
    }
    for (const serial of before) {
      if (now.has(serial)) continue;
      await this.manager.detachSerial(serial, session).catch(() => undefined);
    }
  }

  private async detachAll(session: AgentSession): Promise<void> {
    // Detach every environment that was fed through this session; the owner
    // check keeps attachments made by a replacement session alive.
    const rows = await this.db
      .select({ serial: environments.loggerSerial })
      .from(environments)
      .where(and(eq(environments.agentId, session.agent.id), isNull(environments.deletedAt)))
      .catch(() => [] as { serial: number | null }[]);
    for (const row of rows) {
      if (row.serial !== null) {
        await this.manager.detachSerial(row.serial, session).catch(() => undefined);
      }
    }
  }
}

export type { AgentSession };
