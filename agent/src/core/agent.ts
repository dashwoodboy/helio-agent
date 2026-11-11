/**
 * AgentCore ties discovery, the stick registry and the server link together.
 * No Electron imports — the desktop shell (and the integration tests) drive
 * this class.
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import {
  defaultBroadcastTargets,
  discoverOnce,
  STICK_TCP_PORT,
  tcpProbe,
  tcpSweep,
  type DiscoveryTarget,
} from "./discovery.js";
import { AgentLink, type LinkStatus } from "./link.js";
import { StickRegistry, type StickReport } from "./sticks.js";

export const AGENT_VERSION = "0.1.4";

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
  discoveryIntervalMs?: number;
  ca?: string | Buffer;
  log?: (msg: string) => void;
}

/** Events: "status" (LinkStatus), "sticks" (StickReport[]). */
export class AgentCore extends EventEmitter {
  readonly registry = new StickRegistry();
  readonly link: AgentLink;
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
      log: opts.log,
    });
    this.link.on("status", (status: LinkStatus) => this.emit("status", status));
    for (const stick of opts.manualSticks ?? []) {
      try {
        this.registry.addManual(stick.ip, stick.port ?? STICK_TCP_PORT, stick.serial ?? null);
      } catch {
        // A bad persisted entry must not stop the agent from starting.
      }
    }
  }

  get status(): LinkStatus {
    return this.link.status;
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
      // Manual sticks are probed as unicast UDP targets too: when the stick
      // answers, discovery learns its serial without the user typing it.
      const manual = this.registry.manualEntries();
      const targets = [
        ...(this.opts.discoveryTargets ?? defaultBroadcastTargets()),
        ...manual.map((m) => ({ address: m.ip })),
      ];
      const found = await discoverOnce({ targets });
      if (found.length === 0 && (this.opts.tcpFallback ?? true)) {
        // Sticks whose firmware ignores the UDP probe: sweep for the TCP port.
        const open = await tcpSweep();
        found.push(...open.map((ip) => ({ ip, mac: null, serial: null })));
      }
      const changed = this.registry.update(found);

      // Manual sticks that ignored the UDP probe: a plain TCP connect on
      // their port decides reachable/unreachable.
      const foundIps = new Set(found.map((f) => f.ip));
      let manualChanged = false;
      for (const m of manual) {
        if (foundIps.has(m.ip)) continue;
        if (await tcpProbe(m.ip, m.port, 1500)) {
          this.registry.markManualSeen(m.ip);
          manualChanged = true;
        }
      }

      if (changed || manualChanged) {
        this.link.reportSticks();
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
