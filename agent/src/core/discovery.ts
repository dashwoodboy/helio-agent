/**
 * Solarman stick discovery on the local network.
 *
 * Primary: the sticks answer the well-known UDP probe `WIFIKIT-214028-READ`
 * on port 48899 with `IP,MAC,SERIAL` — that gives us the logger serial
 * without touching the Modbus side. Fallback: a TCP sweep of the local /24
 * on port 8899 finds sticks whose firmware ignores the UDP probe; those are
 * reported with `serial: null` (the user types the label serial).
 *
 * Only private/loopback addresses are ever contacted; the server never
 * supplies addresses to this code.
 */
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";

export const DISCOVERY_PROBE = "WIFIKIT-214028-READ";
export const DISCOVERY_PORT = 48899;
export const STICK_TCP_PORT = 8899;

export interface DiscoveredStick {
  ip: string;
  mac: string | null;
  serial: number | null;
  /** Modbus TCP port; the real sticks always use 8899 (tests override). */
  port?: number;
}

export interface DiscoveryTarget {
  address: string;
  port?: number;
}

/** Syntactically valid dotted-quad IPv4 (any range, including public). */
export function isValidIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((octet) => Number(octet) <= 255);
}

export function isPrivateIp(ip: string): boolean {
  if (/^127(\.\d{1,3}){3}$/.test(ip)) return true; // loopback (dev/tests)
  if (/^10(\.\d{1,3}){3}$/.test(ip)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(ip)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(ip)) return true; // link-local
  const m = ip.match(/^172\.(\d{1,3})(\.\d{1,3}){2}$/);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** Directed broadcast address of an interface (address + netmask). */
export function broadcastAddress(address: string, netmask: string): string {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  return a.map((octet, i) => (octet & m[i]) | (~m[i] & 0xff)).join(".");
}

/** Broadcast targets for every non-internal private IPv4 interface. */
export function defaultBroadcastTargets(): DiscoveryTarget[] {
  const targets: DiscoveryTarget[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal || !isPrivateIp(info.address)) continue;
      targets.push({ address: broadcastAddress(info.address, info.netmask) });
    }
  }
  return targets;
}

/** Parse a `IP,MAC,SERIAL` discovery reply; null for anything else. */
export function parseDiscoveryReply(text: string): DiscoveredStick | null {
  const parts = text.trim().split(",");
  if (parts.length < 2) return null;
  const ip = parts[0].trim();
  if (!isValidIpv4(ip)) return null;
  const mac = parts[1]?.trim() || null;
  const serialRaw = parts[2]?.trim() ?? "";
  const serial = /^\d{6,10}$/.test(serialRaw) ? Number(serialRaw) : null;
  return { ip, mac, serial: serial && serial > 0 ? serial : null };
}

/** One UDP discovery round: probe every target and collect replies. */
export function discoverOnce(
  opts: { timeoutMs?: number; targets?: DiscoveryTarget[] } = {},
): Promise<DiscoveredStick[]> {
  const targets = opts.targets ?? defaultBroadcastTargets();
  const timeoutMs = opts.timeoutMs ?? 2000;
  if (targets.length === 0) return Promise.resolve([]);

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const found = new Map<string, DiscoveredStick>(); // by ip

    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    socket.on("message", (msg, rinfo) => {
      const parsed = parseDiscoveryReply(msg.toString("utf8"));
      if (!parsed) return;
      // Always key by the actual sender: a payload can never steer us at an
      // address we did not contact (a NATed stick reports its internal IP).
      const ip = rinfo.address;
      found.set(ip, { ...parsed, ip });
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // not fatal: unicast targets still work
      }
      const probe = Buffer.from(DISCOVERY_PROBE, "ascii");
      for (const target of targets) {
        socket.send(probe, target.port ?? DISCOVERY_PORT, target.address);
      }
    });
  });
}

/** True when `ip:port` accepts a TCP connection within the timeout. */
export function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port });
    const done = (open: boolean) => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * TCP fallback sweep: probe the given hosts (default: every host of the /24
 * around each local interface) on the stick port. Returns the open IPs.
 */
export async function tcpSweep(
  opts: { hosts?: string[]; port?: number; timeoutMs?: number; concurrency?: number } = {},
): Promise<string[]> {
  const port = opts.port ?? STICK_TCP_PORT;
  const timeoutMs = opts.timeoutMs ?? 400;
  const concurrency = opts.concurrency ?? 64;

  let hosts = opts.hosts;
  if (!hosts) {
    const set = new Set<string>();
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family !== "IPv4" || info.internal || !isPrivateIp(info.address)) continue;
        const base = info.address.split(".").slice(0, 3).join(".");
        for (let host = 1; host <= 254; host++) {
          const ip = `${base}.${host}`;
          if (ip !== info.address) set.add(ip);
        }
      }
    }
    hosts = [...set];
  }
  hosts = hosts.filter(isPrivateIp);

  const open: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
      while (next < hosts.length) {
        const ip = hosts[next++];
        if (await tcpProbe(ip, port, timeoutMs)) open.push(ip);
      }
    }),
  );
  return open.sort();
}
