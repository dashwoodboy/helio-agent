/**
 * Admin report endpoints, restricted to the emails in ADMIN_EMAILS:
 * account/stick totals, recent visit traffic (landing vs environment) and
 * aggregated visitor locations for the world map. Also the tiny
 * GET /api/account/me so the frontend can decide whether to show the link
 * without the admin list ever reaching the public config.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, count, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { environments, memberships, users, visits } from "../db/schema.js";
import type { AuthHooks } from "../auth/plugin.js";
import { geolocateIps, type BatchLookup } from "../services/geoip.js";

/** A stick whose logger reported within this window counts as connected. */
const STICK_ACTIVE_DAYS = 7;

export interface AdminDeps {
  db: Db;
  auth: AuthHooks;
  adminEmails: string[];
  /** Test seam for the ip-api.com batch call. */
  geoLookup?: BatchLookup;
}

const visitsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
});

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, auth, adminEmails } = deps;

  const isAdmin = (req: FastifyRequest) =>
    !!req.user && adminEmails.includes(req.user.email.toLowerCase());

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    await auth.authenticate(req, reply);
    if (reply.sent) return;
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
  };

  app.get("/api/account/me", { preHandler: auth.authenticate }, async (req) => ({
    email: req.user!.email,
    displayName: req.user!.displayName,
    admin: isAdmin(req),
  }));

  app.get("/api/admin/overview", { preHandler: requireAdmin }, async () => {
    const cutoff30d = new Date(Date.now() - 30 * 86400000);
    const stickCutoff = new Date(Date.now() - STICK_ACTIVE_DAYS * 86400000);

    const [[accounts], [accountsRecent], byType, [sticks], [stickOwners]] = await Promise.all([
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(users).where(gte(users.createdAt, cutoff30d)),
      db
        .select({ sourceType: environments.sourceType, n: count() })
        .from(environments)
        .where(isNull(environments.deletedAt))
        .groupBy(environments.sourceType),
      db
        .select({ n: count() })
        .from(environments)
        .where(
          and(
            isNull(environments.deletedAt),
            isNotNull(environments.loggerSerial),
            gte(environments.loggerLastSeenAt, stickCutoff),
          ),
        ),
      db
        .select({ n: sql<number>`count(distinct ${memberships.userId})`.mapWith(Number) })
        .from(memberships)
        .innerJoin(environments, sql`${environments.id} = ${memberships.environmentId}`)
        .where(
          and(
            sql`${memberships.role} = 'owner'`,
            isNull(environments.deletedAt),
            isNotNull(environments.loggerSerial),
            gte(environments.loggerLastSeenAt, stickCutoff),
          ),
        ),
    ]);

    return {
      accounts: { total: accounts.n, last30d: accountsRecent.n },
      environments: {
        total: byType.reduce((acc, r) => acc + r.n, 0),
        byType: Object.fromEntries(byType.map((r) => [r.sourceType, r.n])),
      },
      sticks: { connected: sticks.n, owners: stickOwners.n, activeDays: STICK_ACTIVE_DAYS },
    };
  });

  app.get("/api/admin/visits", { preHandler: requireAdmin }, async (req) => {
    const { days } = visitsQuerySchema.parse(req.query ?? {});
    const cutoff = new Date(Date.now() - days * 86400000);

    const [byDayRows, [totals], ipRows] = await Promise.all([
      db
        .select({
          day: sql<string>`to_char(${visits.ts}, 'YYYY-MM-DD')`,
          kind: visits.kind,
          n: count(),
        })
        .from(visits)
        .where(gte(visits.ts, cutoff))
        .groupBy(sql`1`, visits.kind),
      db
        .select({
          sessions: sql<number>`count(distinct ${visits.sessionId})`.mapWith(Number),
          appSessions: sql<number>`count(distinct ${visits.sessionId}) filter (where ${visits.kind} = 'app')`.mapWith(Number),
        })
        .from(visits)
        .where(gte(visits.ts, cutoff)),
      db
        .select({ ip: visits.ip, n: count() })
        .from(visits)
        .where(and(gte(visits.ts, cutoff), sql`${visits.ip} <> ''`))
        .groupBy(visits.ip),
    ]);

    // Day-by-day split, dense over the whole window so charts have no holes.
    const byDayMap = new Map<string, { landing: number; app: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      byDayMap.set(key, { landing: 0, app: 0 });
    }
    let landingTotal = 0;
    let appTotal = 0;
    for (const row of byDayRows) {
      const entry = byDayMap.get(row.day) ?? { landing: 0, app: 0 };
      entry[row.kind] += row.n;
      byDayMap.set(row.day, entry);
      if (row.kind === "landing") landingTotal += row.n;
      else appTotal += row.n;
    }

    // World map: geolocate the window's IPs (cached in ip_geo) and aggregate
    // visit counts per place.
    const geo = await geolocateIps(db, ipRows.map((r) => r.ip), deps.geoLookup);
    const places = new Map<string, { lat: number; lon: number; city: string; country: string; count: number }>();
    for (const row of ipRows) {
      const loc = geo.get(row.ip);
      if (!loc || loc.lat === null || loc.lon === null) continue;
      const key = `${loc.city}|${loc.country}|${loc.lat.toFixed(1)}|${loc.lon.toFixed(1)}`;
      const place = places.get(key);
      if (place) place.count += row.n;
      else places.set(key, { lat: loc.lat, lon: loc.lon, city: loc.city, country: loc.country, count: row.n });
    }

    return {
      days,
      totals: {
        landing: landingTotal,
        app: appTotal,
        sessions: totals.sessions,
        appSessions: totals.appSessions,
        landingOnlySessions: Math.max(0, totals.sessions - totals.appSessions),
      },
      byDay: [...byDayMap.entries()].map(([date, v]) => ({ date, ...v })),
      locations: [...places.values()].sort((a, b) => b.count - a.count),
    };
  });
}
