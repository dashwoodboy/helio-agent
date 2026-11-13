/**
 * IP geolocation for the admin world map, resolved lazily when the report
 * is opened (never on the visit beacon itself) and cached forever in the
 * ip_geo table. Uses ip-api.com's free batch endpoint (server-side, plain
 * HTTP, 100 IPs per call); failures are cached with null coordinates so a
 * dead IP is not retried on every report load.
 */
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ipGeo } from "../db/schema.js";

export interface GeoResult {
  ip: string;
  lat: number | null;
  lon: number | null;
  city: string;
  country: string;
}

interface IpApiEntry {
  query: string;
  status: "success" | "fail";
  lat?: number;
  lon?: number;
  city?: string;
  country?: string;
}

const BATCH_URL = "http://ip-api.com/batch?fields=status,query,lat,lon,city,country";
const BATCH_SIZE = 100;

/** Loopback, LAN and link-local addresses have no meaningful location. */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const v4 = ip.replace(/^::ffff:/i, "");
  if (v4 === "::1" || v4 === "localhost") return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(v4)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (/^(fc|fd|fe80)/i.test(ip)) return true;
  return false;
}

export type BatchLookup = (ips: string[]) => Promise<IpApiEntry[]>;

const defaultLookup: BatchLookup = async (ips) => {
  const resp = await fetch(BATCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ips),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`ip-api returned ${resp.status}`);
  return (await resp.json()) as IpApiEntry[];
};

/**
 * Geolocate `ips`, serving from the ip_geo cache and resolving only the
 * missing public addresses. Returns every IP that ended up with a location.
 */
export async function geolocateIps(
  db: Db,
  ips: string[],
  lookup: BatchLookup = defaultLookup,
): Promise<Map<string, GeoResult>> {
  const publicIps = [...new Set(ips.filter((ip) => !isPrivateIp(ip)))];
  const results = new Map<string, GeoResult>();
  if (publicIps.length === 0) return results;

  const cached = await db.select().from(ipGeo).where(inArray(ipGeo.ip, publicIps));
  for (const row of cached) {
    results.set(row.ip, { ip: row.ip, lat: row.lat, lon: row.lon, city: row.city, country: row.country });
  }

  const missing = publicIps.filter((ip) => !results.has(ip));
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    let entries: IpApiEntry[];
    try {
      entries = await lookup(batch);
    } catch {
      break; // offline / rate-limited: report what we have, retry next load
    }
    const rows: (typeof ipGeo.$inferInsert)[] = [];
    for (const e of entries) {
      const geo: GeoResult =
        e.status === "success"
          ? { ip: e.query, lat: e.lat ?? null, lon: e.lon ?? null, city: e.city ?? "", country: e.country ?? "" }
          : { ip: e.query, lat: null, lon: null, city: "", country: "" };
      results.set(geo.ip, geo);
      rows.push({ ip: geo.ip, lat: geo.lat, lon: geo.lon, city: geo.city, country: geo.country });
    }
    if (rows.length > 0) {
      await db.insert(ipGeo).values(rows).onConflictDoNothing();
    }
  }
  return results;
}
