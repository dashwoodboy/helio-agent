/**
 * Outbound WebSocket link to the Helio server (`/ws/agent`).
 *
 * Security properties: the URL comes from the server-URL policy (TLS except
 * loopback), the token travels only in the `Authorization` header (never in
 * the URL), and certificate verification is never disabled — an optional
 * extra CA can be *added* for private deployments, which does not weaken
 * verification against the system store.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { parseServerUrl } from "./serverUrl.js";
import type { StickRegistry } from "./sticks.js";

/** Must match the backend's AGENT_PROTOCOL_VERSION. */
export const AGENT_PROTOCOL_VERSION = 1;

/** Close codes assigned by the server. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REVOKED = 4403;
const CLOSE_REPLACED = 4409;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
/** Re-report sticks at least this often even without changes. */
const STICKS_REFRESH_MS = 60000;

export type LinkStatus =
  | "idle"
  | "connecting"
  | "online"
  | "offline"
  | "unauthorized"
  | "replaced";

export interface LinkOptions {
  serverUrl: string;
  token: string;
  name: string;
  platform: string;
  version: string;
  registry: StickRegistry;
  /** Extra trusted CA (PEM) for private deployments; never replaces the system store. */
  ca?: string | Buffer;
  log?: (msg: string) => void;
}

interface RpcMessage {
  type: "rpc";
  id: string;
  serial: number;
  op: "read" | "write1" | "writeN";
  addr: number;
  quantity?: number;
  value?: number;
  values?: number[];
}

/**
 * Events: "status" (LinkStatus), "ready" ({agentId, name}).
 */
export class AgentLink extends EventEmitter {
  status: LinkStatus = "idle";
  private ws: WebSocket | null = null;
  private stopped = true;
  private reconnectMs = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sticksTimer: NodeJS.Timeout | null = null;
  private lastReport = "";

  constructor(private readonly opts: LinkOptions) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sticksTimer) clearInterval(this.sticksTimer);
    this.sticksTimer = null;
    this.ws?.close(1000, "agent stopped");
    this.ws = null;
    this.setStatus("idle");
  }

  /** Push the current stick list if it changed since the last report. */
  reportSticks(force = false): void {
    if (this.status !== "online" || !this.ws) return;
    const sticks = this.opts.registry.report();
    const encoded = JSON.stringify(sticks);
    if (!force && encoded === this.lastReport) return;
    this.lastReport = encoded;
    this.send({ type: "sticks", sticks });
  }

  private setStatus(status: LinkStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const { agentWsUrl } = parseServerUrl(this.opts.serverUrl);
    this.setStatus("connecting");
    this.log(`Connecting to ${agentWsUrl}`);

    // Token in the Authorization header only; rejectUnauthorized stays on.
    const ws = new WebSocket(agentWsUrl, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      ...(this.opts.ca ? { ca: this.opts.ca } : {}),
      maxPayload: 64 * 1024,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.send({
        type: "hello",
        protocol: AGENT_PROTOCOL_VERSION,
        version: this.opts.version,
        platform: this.opts.platform,
        name: this.opts.name,
      });
    });

    ws.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "ready") {
        this.reconnectMs = RECONNECT_MIN_MS;
        this.setStatus("online");
        this.emit("ready", { agentId: msg.agentId, name: msg.name });
        this.lastReport = "";
        this.reportSticks(true);
        if (this.sticksTimer) clearInterval(this.sticksTimer);
        this.sticksTimer = setInterval(() => this.reportSticks(true), STICKS_REFRESH_MS);
        this.sticksTimer.unref?.();
      } else if (msg.type === "rpc") {
        void this.handleRpc(msg as unknown as RpcMessage);
      }
    });

    ws.on("close", (code, reason) => {
      if (this.ws === ws) this.ws = null;
      if (this.sticksTimer) clearInterval(this.sticksTimer);
      this.sticksTimer = null;
      if (this.stopped) return;
      this.log(`Disconnected (${code} ${reason.toString()})`);
      if (code === CLOSE_UNAUTHORIZED || code === CLOSE_REVOKED) {
        // The token is dead: reconnecting cannot help, the user must pair again.
        this.setStatus("unauthorized");
        return;
      }
      if (code === CLOSE_REPLACED) {
        // Another instance of this agent took over; don't fight it.
        this.setStatus("replaced");
        return;
      }
      this.setStatus("offline");
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.log(`Socket error: ${err.message}`);
      // "close" follows and handles the retry.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async handleRpc(msg: RpcMessage): Promise<void> {
    const { registry } = this.opts;
    try {
      if (msg.op === "read") {
        const values = await registry.read(msg.serial, msg.addr, msg.quantity ?? 1);
        this.send({ type: "result", id: msg.id, ok: true, values });
      } else if (msg.op === "write1") {
        await registry.write1(msg.serial, msg.addr, msg.value ?? 0);
        this.send({ type: "result", id: msg.id, ok: true });
      } else if (msg.op === "writeN") {
        await registry.writeN(msg.serial, msg.addr, msg.values ?? []);
        this.send({ type: "result", id: msg.id, ok: true });
      } else {
        this.send({ type: "result", id: msg.id, ok: false, error: "unsupported operation" });
      }
    } catch (err) {
      this.send({
        type: "result",
        id: msg.id,
        ok: false,
        error: (err as Error).message.slice(0, 300),
      });
    }
  }
}
