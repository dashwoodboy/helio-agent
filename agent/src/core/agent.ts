/**
 * AgentCore ties discovery, the stick registry and the server link together.
 * No Electron imports — the desktop shell (and the integration tests) drive
 * this class.
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import { discoverOnce, tcpSweep, type DiscoveryTarget } from "./discovery.js";
import { AgentLink, type LinkStatus } from "./link.js";
import { StickRegistry, type StickReport } from "./sticks.js";

export const AGENT_VERSION = "0.1.0";

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
      const found = await discoverOnce({ targets: this.opts.discoveryTargets });
      if (found.length === 0 && (this.opts.tcpFallback ?? true)) {
        // Sticks whose firmware ignores the UDP probe: sweep for the TCP port.
        const open = await tcpSweep();
        found.push(...open.map((ip) => ({ ip, mac: null, serial: null })));
      }
      const changed = this.registry.update(found);
      if (changed) {
        this.link.reportSticks();
        this.emit("sticks", this.sticks);
      }
      return this.sticks;
    } finally {
      this.discovering = false;
    }
  }
}
