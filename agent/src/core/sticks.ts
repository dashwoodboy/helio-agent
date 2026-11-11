/**
 * Registry of the sticks discovery found, plus the Modbus executors the
 * server link calls. The Solarman V5 client is the backend's own
 * (`@solarman` alias), so the protocol has one source of truth.
 *
 * The server only ever names a stick by serial; the address comes from our
 * own discovery — a compromised server cannot point the agent at arbitrary
 * hosts. Requests are serialized per stick and sockets close when idle.
 */
import { SolarmanClient } from "@solarman/client.js";
import { isPrivateIp, STICK_TCP_PORT, type DiscoveredStick } from "./discovery.js";

/** A stick disappears from reports when unseen for this long. */
const STALE_MS = 90_000;
/** Close a stick's TCP socket after this much inactivity. */
const IDLE_CLOSE_MS = 60_000;
/** Mirror of the server's cap on reported sticks. */
const MAX_REPORTED = 32;

export interface StickReport {
  serial: number | null;
  ip: string;
  mac: string | null;
  reachable: boolean;
  /** Added by hand (IP + port) rather than found by discovery. */
  manual: boolean;
}

interface StickEntry {
  ip: string;
  mac: string | null;
  serial: number | null;
  port: number;
  lastSeenAt: number;
  /** Manual entries are pinned: they never expire, only report unreachable. */
  manual: boolean;
}

interface ClientEntry {
  client: SolarmanClient;
  ip: string;
  chain: Promise<unknown>;
  idleTimer: NodeJS.Timeout | null;
}

export class StickRegistry {
  /** Keyed by ip (sticks without a serial still get listed). */
  private readonly entries = new Map<string, StickEntry>();
  private readonly clients = new Map<number, ClientEntry>();

  /** Merge one discovery round; returns true when the report changed. */
  update(found: DiscoveredStick[]): boolean {
    const before = JSON.stringify(this.report());
    const now = Date.now();
    for (const stick of found) {
      if (!isPrivateIp(stick.ip)) continue;
      const existing = this.entries.get(stick.ip);
      this.entries.set(stick.ip, {
        ip: stick.ip,
        mac: stick.mac ?? existing?.mac ?? null,
        serial: stick.serial ?? existing?.serial ?? null,
        port: stick.port ?? existing?.port ?? STICK_TCP_PORT,
        lastSeenAt: now,
        manual: existing?.manual ?? false,
      });
    }
    for (const [ip, entry] of this.entries) {
      if (!entry.manual && now - entry.lastSeenAt > STALE_MS) this.entries.delete(ip);
    }
    return JSON.stringify(this.report()) !== before;
  }

  /**
   * Pin a stick the user typed in by hand (discovery can't see it: other
   * subnet, UDP probe ignored, …). It never expires; `markManualSeen`
   * refreshes its reachability after each probe round.
   */
  addManual(ip: string, port = STICK_TCP_PORT): boolean {
    if (!isPrivateIp(ip)) throw new Error(`"${ip}" is not a private LAN address`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`"${port}" is not a valid TCP port`);
    }
    const existing = this.entries.get(ip);
    const before = JSON.stringify(this.report());
    this.entries.set(ip, {
      ip,
      mac: existing?.mac ?? null,
      serial: existing?.serial ?? null,
      port,
      // Unseen until the first probe confirms it answers.
      lastSeenAt: existing?.lastSeenAt ?? 0,
      manual: true,
    });
    return JSON.stringify(this.report()) !== before;
  }

  /** Unpin a manual stick (also forgets it entirely when discovery can't see it). */
  removeManual(ip: string): boolean {
    const entry = this.entries.get(ip);
    if (!entry?.manual) return false;
    this.entries.delete(ip);
    return true;
  }

  /** Manual entries, so the discovery round knows what to probe. */
  manualEntries(): { ip: string; port: number }[] {
    return [...this.entries.values()]
      .filter((e) => e.manual)
      .map((e) => ({ ip: e.ip, port: e.port }));
  }

  /** A manual stick answered a probe: refresh its reachability window. */
  markManualSeen(ip: string): void {
    const entry = this.entries.get(ip);
    if (entry?.manual) entry.lastSeenAt = Date.now();
  }

  /** Current sticks, shaped like the hub's `sticks` message. */
  report(): StickReport[] {
    const now = Date.now();
    return [...this.entries.values()]
      .slice(0, MAX_REPORTED)
      .map((e) => ({
        serial: e.serial,
        ip: e.ip,
        mac: e.mac,
        reachable: now - e.lastSeenAt <= STALE_MS,
        manual: e.manual,
      }))
      .sort((a, b) => (a.serial ?? 0) - (b.serial ?? 0) || a.ip.localeCompare(b.ip));
  }

  // ----------------------------------------------------- Modbus executors

  read(serial: number, addr: number, quantity: number): Promise<number[]> {
    return this.enqueue(serial, (client) => client.readHoldingRegisters(addr, quantity));
  }

  async write1(serial: number, addr: number, value: number): Promise<void> {
    await this.enqueue(serial, (client) => client.writeHoldingRegister(addr, value));
  }

  async writeN(serial: number, addr: number, values: number[]): Promise<void> {
    await this.enqueue(serial, (client) => client.writeHoldingRegisters(addr, values));
  }

  /** Close every open stick socket (shutdown). */
  async close(): Promise<void> {
    for (const [serial, entry] of this.clients) {
      this.clients.delete(serial);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      await entry.client.disconnect().catch(() => undefined);
    }
  }

  private entryForSerial(serial: number): StickEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.serial === serial) return entry;
    }
    return null;
  }

  private enqueue<T>(serial: number, run: (client: SolarmanClient) => Promise<T>): Promise<T> {
    const stick = this.entryForSerial(serial);
    if (!stick) return Promise.reject(new Error(`Stick ${serial} is not visible on this network`));

    let entry = this.clients.get(serial);
    if (!entry || entry.ip !== stick.ip) {
      if (entry) void entry.client.disconnect().catch(() => undefined);
      entry = {
        client: new SolarmanClient({ address: stick.ip, serial, port: stick.port }),
        ip: stick.ip,
        chain: Promise.resolve(),
        idleTimer: null,
      };
      this.clients.set(serial, entry);
    }

    const current = entry;
    const task = current.chain.then(
      () => run(current.client),
      () => run(current.client),
    );
    current.chain = task.catch(() => undefined);
    void current.chain.then(() => this.scheduleIdleClose(serial, current));
    return task;
  }

  private scheduleIdleClose(serial: number, entry: ClientEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.clients.get(serial) === entry) this.clients.delete(serial);
      void entry.client.disconnect().catch(() => undefined);
    }, IDLE_CLOSE_MS);
    entry.idleTimer.unref?.();
  }
}
