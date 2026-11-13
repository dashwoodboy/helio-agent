/**
 * Outbound WebSocket link to the Helio server (`/ws/agent`).
 *
 * Security properties: the URL comes from the server-URL policy (TLS except
 * loopback), the token travels only in the `Authorization` header (never in
 * the URL), and certificate verification is never disabled — an optional
 * extra CA can be *added* for private deployments, which does not weaken
 * verification against the system store.
 *
 * Resilience properties: the TLS/HTTP handshake has a hard timeout, a
 * watchdog terminates half-open sockets that stop carrying pings/messages,
 * reconnects back off exponentially with jitter (so a fleet doesn't stampede
 * a restarting server), and a lost token is only declared dead after two
 * consecutive 4401s (one can be a proxy/server hiccup).
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
const CLOSE_PROTOCOL = 4426;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
/** Give up on a TCP/TLS/upgrade handshake after this long. */
const HANDSHAKE_TIMEOUT_MS = 15000;
/** The server pings every 30 s; no traffic for this long means half-open. */
const WATCHDOG_MS = 75000;
const WATCHDOG_CHECK_MS = 5000;
/** Re-report sticks at least this often even without changes. */
const STICKS_REFRESH_MS = 60000;

export type LinkStatus =
  | "idle"
  | "connecting"
  | "online"
  | "offline"
  | "unauthorized"
  | "replaced"
  | "update_required";

export interface LinkStatusDetail {
  status: LinkStatus;
  /** WebSocket close code (or null when not caused by a close). */
  code: number | null;
  /** Short human-readable reason for the current state. */
  message: string;
  /** Epoch ms of the next automatic reconnect attempt, when one is scheduled. */
  nextRetryAt: number | null;
}

export interface LinkReadyInfo {
  agentId: string;
  name: string;
  /** Server clock at hello time (ISO string), when the server sends it. */
  serverTime: string | null;
  /** Newest published agent version, when the server advertises one. */
  latestAgentVersion: string | null;
  /** Oldest version the server still likes; older agents should update. */
  minAgentVersion: string | null;
}

export interface LinkOptions {
  serverUrl: string;
  token: string;
  name: string;
  platform: string;
  version: string;
  registry: StickRegistry;
  /** Extra trusted CA (PEM) for private deployments; never replaces the system store. */
  ca?: string | Buffer;
  /**
   * HTTP agent for the WebSocket (e.g. an HttpsProxyAgent when the OS or
   * HTTPS_PROXY says the server is only reachable through a proxy).
   */
  wsAgent?: import("node:http").Agent;
  log?: (msg: string) => void;
  /** Timing overrides (tests only). */
  timeouts?: {
    handshakeTimeoutMs?: number;
    watchdogMs?: number;
    watchdogCheckMs?: number;
    reconnectMinMs?: number;
  };
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
 * Events: "status" (LinkStatusDetail), "ready" (LinkReadyInfo).
 */
export class AgentLink extends EventEmitter {
  status: LinkStatus = "idle";
  detail: LinkStatusDetail = { status: "idle", code: null, message: "", nextRetryAt: null };
  private ws: WebSocket | null = null;
  private stopped = true;
  private readonly reconnectMinMs: number;
  private reconnectMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastReport = "";
  /** Consecutive 4401 closes; the token is only dropped at 2. */
  private authStrikes = 0;

  constructor(private readonly opts: LinkOptions) {
    super();
    this.reconnectMinMs = opts.timeouts?.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMs = this.reconnectMinMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "agent stopped");
    this.setStatus("idle");
  }

  /**
   * Drop whatever connection exists (even a hung one) and try again right
   * now with the backoff reset. Wired to the "Try now" button, OS resume,
   * and network-interface changes.
   */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectMs = this.reconnectMinMs;
    const old = this.ws;
    this.ws = null; // close handler of the old socket sees it was replaced
    old?.terminate();
    this.connect();
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

  private setStatus(
    status: LinkStatus,
    info: { code?: number | null; message?: string; nextRetryAt?: number | null } = {},
  ): void {
    const detail: LinkStatusDetail = {
      status,
      code: info.code ?? null,
      message: info.message ?? "",
      nextRetryAt: info.nextRetryAt ?? null,
    };
    const unchanged =
      this.status === detail.status &&
      this.detail.code === detail.code &&
      this.detail.message === detail.message &&
      this.detail.nextRetryAt === detail.nextRetryAt;
    this.status = status;
    this.detail = detail;
    if (!unchanged) this.emit("status", detail);
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
      ...(this.opts.wsAgent ? { agent: this.opts.wsAgent } : {}),
      maxPayload: 64 * 1024,
      handshakeTimeout: this.opts.timeouts?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;

    // The last socket error; used as the offline reason when the close
    // carries no useful code (TLS failures close with 1006 and no reason).
    let lastError = "";

    // Watchdog: the server pings every 30 s, so a socket with no traffic for
    // 75 s is half-open (sleep, NAT drop, dead Wi-Fi). Terminate it — the
    // close handler reconnects. Timers are per-socket; replaced sockets
    // can't touch the current one.
    let lastActivity = Date.now();
    const sawTraffic = () => {
      lastActivity = Date.now();
    };
    const watchdogMs = this.opts.timeouts?.watchdogMs ?? WATCHDOG_MS;
    const watchdog = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastActivity > watchdogMs) {
        this.log(`Watchdog: no traffic for ${Math.round(watchdogMs / 1000)}s, reconnecting`);
        ws.terminate();
      }
    }, this.opts.timeouts?.watchdogCheckMs ?? WATCHDOG_CHECK_MS);
    watchdog.unref?.();

    let sticksTimer: NodeJS.Timeout | null = null;

    ws.on("ping", sawTraffic);
    ws.on("pong", sawTraffic);

    ws.on("open", () => {
      sawTraffic();
      this.send({
        type: "hello",
        protocol: AGENT_PROTOCOL_VERSION,
        version: this.opts.version,
        platform: this.opts.platform,
        name: this.opts.name,
      });
    });

    ws.on("message", (raw: Buffer) => {
      sawTraffic();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "ready") {
        this.reconnectMs = this.reconnectMinMs;
        this.authStrikes = 0;
        this.setStatus("online");
        this.emit("ready", {
          agentId: String(msg.agentId ?? ""),
          name: String(msg.name ?? ""),
          serverTime: typeof msg.serverTime === "string" ? msg.serverTime : null,
          latestAgentVersion:
            typeof msg.latestAgentVersion === "string" ? msg.latestAgentVersion : null,
          minAgentVersion: typeof msg.minAgentVersion === "string" ? msg.minAgentVersion : null,
        } satisfies LinkReadyInfo);
        this.lastReport = "";
        this.reportSticks(true);
        if (sticksTimer) clearInterval(sticksTimer);
        sticksTimer = setInterval(() => this.reportSticks(true), STICKS_REFRESH_MS);
        sticksTimer.unref?.();
      } else if (msg.type === "rpc") {
        void this.handleRpc(msg as unknown as RpcMessage);
      }
    });

    ws.on("close", (code, reason) => {
      clearInterval(watchdog);
      if (sticksTimer) clearInterval(sticksTimer);
      sticksTimer = null;
      if (this.ws !== ws) return; // replaced by reconnectNow()/stop(); not ours to handle
      this.ws = null;
      if (this.stopped) return;
      const reasonText = reason.toString();
      this.log(`Disconnected (${code} ${reasonText})`);

      if (code === CLOSE_REVOKED) {
        // Revoked by the user on the website: definitive, no second opinion.
        this.setStatus("unauthorized", {
          code,
          message: "This device's access was revoked. Pair it again to reconnect.",
        });
        return;
      }
      if (code === CLOSE_UNAUTHORIZED) {
        this.authStrikes++;
        if (this.authStrikes >= 2) {
          // Two rejections in a row: the token really is dead.
          this.setStatus("unauthorized", {
            code,
            message: "This device is no longer paired. Pair it again to reconnect.",
          });
          return;
        }
        // One 4401 can be a proxy/server hiccup; confirm before dropping the
        // token (losing it forces the user through pairing again).
        const nextRetryAt = this.scheduleReconnect();
        this.setStatus("offline", {
          code,
          message: "The server rejected the credentials; checking again.",
          nextRetryAt,
        });
        return;
      }
      if (code === CLOSE_REPLACED) {
        // Another instance of this agent took over; don't fight it.
        this.setStatus("replaced", {
          code,
          message: "Another copy of this agent connected with the same pairing.",
        });
        return;
      }
      if (code === CLOSE_PROTOCOL) {
        // Protocol/TLS requirements not met: reconnecting with the same
        // build cannot help. The shell shows an "update required" screen.
        this.setStatus("update_required", {
          code,
          message:
            reasonText || "The server requires a newer agent version. Please update the app.",
        });
        return;
      }

      const nextRetryAt = this.scheduleReconnect();
      this.setStatus("offline", {
        code,
        message: reasonText || lastError || (code === 1006 ? "Connection lost." : ""),
        nextRetryAt,
      });
    });

    ws.on("error", (err) => {
      lastError = err.message;
      this.log(`Socket error: ${err.message}`);
      // "close" follows and handles the retry.
    });
  }

  /** Schedule the next attempt; returns its epoch ms (0 when not scheduled). */
  private scheduleReconnect(): number {
    if (this.stopped || this.reconnectTimer) return 0;
    const base = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    // Jitter: 50–100% of the backoff window, so agents that lost the same
    // server don't all reconnect in the same second.
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    const nextRetryAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
    return nextRetryAt;
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
