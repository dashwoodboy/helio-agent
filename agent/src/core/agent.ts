/**
 * AgentCore ties discovery, the stick registry and the server link together.
 * No Electron imports — the desktop shell (and the integration tests) drive
 * this class.
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import {
  defaultBroadcastTargets,
  discoverDetailed,
  STICK_TCP_PORT,
  tcpProbe,
  tcpSweep,
  type DiscoveryIssue,
  type DiscoveryTarget,
} from "./discovery.js";
import {
  AgentLink,
  type LinkReadyInfo,
  type LinkStatus,
  type LinkStatusDetail,
} from "./link.js";
import { StickRegistry, type StickReport } from "./sticks.js";

export const AGENT_VERSION = "0.2.0";

const DISCOVERY_INTERVAL_MS = 30_000;

export function platformName(): string {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function defaultAgentName(): string {
  return os.hostname().replace(/\.local$/i, "") || "My computer";
}

export interface AgentCoreOptions {
  serverUrl: string;
  token: string;
  name?: string;
  /** Override discovery targets (tests); default: LAN broadcast. */
  discoveryTargets?: DiscoveryTarget[];
  /** Also TCP-sweep the /24 when UDP finds nothing (slow; default true). */
  tcpFallback?: boolean;
  /** Sticks the user pinned by hand (IP + port + optional serial); kept across restarts by the shell. */
  manualSticks?: { ip: string; port?: number; serial?: number | null }[];
  /**
   * Sticks remembered from the previous run (persisted by the shell). They
   * seed discovery so a stick that ignores UDP probes is found again by a
   * direct TCP probe within the first round.
   */
  knownSticks?: { ip: string; port?: number; serial?: number | null }[];
  discoveryIntervalMs?: number;
  ca?: string | Buffer;
  /** Proxy agent for the WebSocket uplink (OS proxy / HTTPS_PROXY). */
  wsAgent?: import("node:http").Agent;
  log?: (msg: string) => void;
}

/** Events: "status" (LinkStatusDetail), "ready" (LinkReadyInfo), "sticks" (StickReport[]). */
export class AgentCore extends EventEmitter {
  readonly registry = new StickRegistry();
  readonly link: AgentLink;
  /** Why the last discovery round found nothing (OS/permission causes). */
  discoveryIssue: DiscoveryIssue | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discovering = false;

  constructor(private readonly opts: AgentCoreOptions) {
    super();
    this.link = new AgentLink({
      serverUrl: opts.serverUrl,
      token: opts.token,
      name: opts.name ?? defaultAgentName(),
      platform: platformName(),
      version: AGENT_VERSION,
      registry: this.registry,
      ca: opts.ca,
      wsAgent: opts.wsAgent,
      log: opts.log,
    });
    this.link.on("status", (detail: LinkStatusDetail) => this.emit("status", detail));
    this.link.on("ready", (info: LinkReadyInfo) => this.emit("ready", info));
    for (const stick of opts.manualSticks ?? []) {
      try {
        this.registry.addManual(stick.ip, stick.port ?? STICK_TCP_PORT, stick.serial ?? null);
      } catch {
        // A bad persisted entry must not stop the agent from starting.
      }
    }
    this.registry.seed(opts.knownSticks ?? []);
  }

  get status(): LinkStatus {
    return this.link.status;
  }

  get statusDetail(): LinkStatusDetail {
    return this.link.detail;
  }

  /** Drop the current socket (even a hung one) and reconnect immediately. */
  reconnectNow(): void {
    this.link.reconnectNow();
  }

  get sticks(): StickReport[] {
    return this.registry.report();
  }

  start(): void {
    this.link.start();
    void this.runDiscovery();
    this.discoveryTimer = setInterval(
      () => void this.runDiscovery(),
      this.opts.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS,
    );
    this.discoveryTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    this.link.stop();
    await this.registry.close();
  }

  /** One discovery round (also callable from a "Rescan" button). */
  async runDiscovery(): Promise<StickReport[]> {
    if (this.discovering) return this.sticks;
    this.discovering = true;
    try {
      const before = JSON.stringify(this.registry.report());

      // Every known stick (manual, remembered from the last run, or found
      // earlier) is also probed as a unicast UDP target: when it answers,
      // discovery learns its serial without the user typing it.
      const known = this.registry.knownEntries();
      const targets = [
        ...(this.opts.discoveryTargets ?? defaultBroadcastTargets()),
        ...known.map((k) => ({ address: k.ip })),
      ];
      const { sticks: found, issue } = await discoverDetailed({ targets });
      const issueChanged = issue !== this.discoveryIssue;
      this.discoveryIssue = issue;
      if (found.length === 0 && (this.opts.tcpFallback ?? true)) {
        // Sticks whose firmware ignores the UDP probe: sweep for the TCP port.
        const open = await tcpSweep();
        found.push(...open.map((ip) => ({ ip, mac: null, serial: null })));
      }

      // Known sticks that stayed silent on UDP: a plain TCP connect on their
      // port decides reachable/unreachable BEFORE the registry counts them
      // as stale — firmware that ignores the probe must not flap offline.
      const foundIps = new Set(found.map((f) => f.ip));
      for (const k of known) {
        if (foundIps.has(k.ip)) continue;
        if (await tcpProbe(k.ip, k.port, 1500)) this.registry.markSeen(k.ip);
      }

      this.registry.update(found);

      const changed = JSON.stringify(this.registry.report()) !== before;
      if (changed) {
        this.link.reportSticks();
      }
      if (changed || issueChanged) {
        this.emit("sticks", this.sticks);
      }
      return this.sticks;
    } finally {
      this.discovering = false;
    }
  }

  /** Pin a stick by hand; returns the updated list (throws on bad input). */
  async addManualStick(
    ip: string,
    port = STICK_TCP_PORT,
    serial: number | null = null,
  ): Promise<StickReport[]> {
    this.registry.addManual(ip.trim(), port, serial);
    await this.runDiscovery();
    this.link.reportSticks();
    this.emit("sticks", this.sticks);
    return this.sticks;
  }

  /** The user typed the label serial for a stick listed as "serial unknown". */
  setStickSerial(ip: string, serial: number): StickReport[] {
    if (this.registry.setSerial(ip, serial)) {
      this.link.reportSticks();
      this.emit("sticks", this.sticks);
    }
    return this.sticks;
  }

  /** Forget a manually pinned stick. */
  removeManualStick(ip: string): StickReport[] {
    if (this.registry.removeManual(ip)) {
      this.link.reportSticks();
      this.emit("sticks", this.sticks);
    }
    return this.sticks;
  }
}
