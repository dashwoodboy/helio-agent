import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { config, APP_VERSION } from "../config.js";
import type { Db } from "../db/client.js";
import { dailyWeather, dashboardLayouts, environments, memberships, pushSubscriptions, users, type DashboardLayout } from "../db/schema.js";
import type { LoggerGateway } from "../gateway/server.js";
import { isValidTimezone, localDateKey } from "../lib/time.js";
import type { AuthHooks } from "../auth/plugin.js";
import type { EnvironmentRow, EnvironmentRuntime } from "../runtime/environment.js";
import type { RuntimeManager } from "../runtime/manager.js";
import { appSettingsSchema, type AppSettings } from "../services/settings.js";
import { getVapidKeys } from "../services/push.js";
import { PV_UNDERPERFORMANCE_FACTOR } from "../services/alerts.js";
import { computeSavings, totalsFor } from "../services/analytics.js";
import { SolarmanClient } from "../solarman/client.js";
import { DeyeInverter } from "../inverter/reader.js";
import { registerInverterRoutes } from "./inverter.js";
import { registerAgentRoutes } from "./agents.js";
import type { AgentHub } from "../agent/hub.js";
import type { PairingStore } from "../agent/pairing.js";
import { agents } from "../db/schema.js";

export interface ApiDeps {
  db: Db;
  manager: RuntimeManager;
  gateway: LoggerGateway | null;
  auth: AuthHooks;
  hub: AgentHub;
  pairing: PairingStore;
}

const envCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    timezone: z.string().refine(isValidTimezone, "invalid timezone"),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    sourceType: z.enum(["gateway", "simulator", "direct", "agent"]).default("gateway"),
    inverterIp: z.string().trim().min(1).max(253).optional(),
    inverterPort: z.number().int().min(1).max(65535).optional(),
    loggerSerial: z.number().int().min(1).max(0xffffffff).optional(),
    agentId: z.string().uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.sourceType === "direct") {
      if (!v.inverterIp) {
        ctx.addIssue({ code: "custom", path: ["inverterIp"], message: "required for direct environments" });
      }
      if (!v.loggerSerial) {
        ctx.addIssue({ code: "custom", path: ["loggerSerial"], message: "required for direct environments" });
      }
    }
    if (v.sourceType === "agent") {
      if (!v.agentId) {
        ctx.addIssue({ code: "custom", path: ["agentId"], message: "required for agent environments" });
      }
      if (!v.loggerSerial) {
        ctx.addIssue({ code: "custom", path: ["loggerSerial"], message: "required for agent environments" });
      }
    }
  });

const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(1024),
});

/** A member's personal dashboard arrangement (order + size per widget). */
const layoutSchema = z.object({
  widgets: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(64),
        size: z.enum(["sm", "lg", "full"]),
      }),
    )
    .max(32),
});

/** Wire format for a direct environment's connection details. */
const connectionSchema = z.object({
  ip: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(8899),
  serial: z.number().int().min(1).max(0xffffffff),
});

/**
 * Probe a stick's local TCP port: detect capabilities and take one live
 * reading. Never writes anything; used by the wizard and Settings.
 */
async function testDirectConnection(ip: string, port: number, serial: number) {
  const client = new SolarmanClient({ address: ip, serial, port, socketTimeoutMs: 6000 });
  try {
    const inverter = new DeyeInverter(client, {});
    const detected = await inverter.detectConfig();
    const live = await inverter.readLive(detected);
    return {
      ok: true as const,
      config: detected,
      sample: { pvW: live.pvW, loadW: live.loadW, gridW: live.gridW, battW: live.battW, soc: live.soc },
    };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/**
 * Switch how an existing environment gets its data: "direct" (this server
 * polls the stick's LAN port) or "gateway" (the stick connects out to us).
 * The environment, its history and its members all stay.
 */
const sourceSwitchSchema = z.discriminatedUnion("sourceType", [
  z.object({ sourceType: z.literal("gateway") }),
  connectionSchema.extend({ sourceType: z.literal("direct") }),
  z.object({
    sourceType: z.literal("agent"),
    agentId: z.string().uuid(),
    serial: z.number().int().min(1).max(0xffffffff),
  }),
]);

const envPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  timezone: z.string().refine(isValidTimezone, "invalid timezone").optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

const serialSchema = z.object({
  serial: z.number().int().min(1).max(0xffffffff),
});

/** Invite an existing account to an environment. Ownership is not transferable. */
const memberAddSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["installer", "viewer"]).default("viewer"),
});

const memberPatchSchema = z.object({
  role: z.enum(["installer", "viewer"]),
});

const memberIdSchema = z.coerce.number().int().min(1);

/** Whether the environment's stick is reachable right now (gateway or agent). */
function stickConnected(row: EnvironmentRow, gateway: LoggerGateway | null, hub: AgentHub): boolean {
  if (row.loggerSerial === null) return false;
  if (row.sourceType === "agent") {
    return row.agentId !== null && hub.hasStick(row.agentId, row.loggerSerial);
  }
  return gateway?.isConnected(row.loggerSerial) ?? false;
}

function envSummary(
  row: EnvironmentRow,
  role: string,
  gateway: LoggerGateway | null,
  hub: AgentHub,
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    lat: row.lat,
    lon: row.lon,
    sourceType: row.sourceType,
    role,
    loggerSerial: row.loggerSerial,
    loggerConnected: stickConnected(row, gateway, hub),
    loggerLastSeenAt: row.loggerLastSeenAt?.toISOString() ?? null,
    agentId: row.agentId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, manager, gateway, auth, hub, pairing } = deps;

  registerAgentRoutes(app, { db, auth, hub, pairing });

  /** The caller must own this agent (active, not revoked); null otherwise. */
  const ownedAgent = async (userId: number, agentId: string) => {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId), isNull(agents.revokedAt)));
    return rows[0] ?? null;
  };

  // ----------------------------------------------------------------- public

  app.get("/api/system/health", async () => {
    let dbOk = true;
    try {
      await db.execute(sql`select 1`);
    } catch {
      dbOk = false;
    }
    return { ok: dbOk, dbOk, version: APP_VERSION };
  });

  /** Public bootstrap info the SPA needs before login. */
  app.get("/api/system/config", async () => ({
    version: APP_VERSION,
    authMode: config.authMode,
    logger: {
      host: config.publicLoggerHost,
      port: config.publicLoggerPort,
    },
    agent: {
      downloadBaseUrl: config.agentDownloadBaseUrl,
    },
  }));

  // ----------------------------------------------------------- environments

  app.register(async (envApi) => {
    envApi.addHook("preHandler", auth.authenticate);

    // ------------------------------------------------------------- web push
    // Subscriptions belong to the account (one per browser/device); alerts
    // from every environment the account is a member of will reach them.

    envApi.get("/api/push/public-key", async () => {
      const { publicKey } = await getVapidKeys(db);
      return { publicKey };
    });

    envApi.post("/api/push/subscribe", async (req, reply) => {
      const body = pushSubscribeSchema.parse(req.body ?? {});
      await db
        .insert(pushSubscriptions)
        .values({
          userId: req.user!.id,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId: req.user!.id, p256dh: body.keys.p256dh, auth: body.keys.auth },
        });
      return reply.code(201).send({ ok: true });
    });

    envApi.delete("/api/push/subscribe", async (req) => {
      const { endpoint } = pushUnsubscribeSchema.parse(req.body ?? {});
      await db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, req.user!.id)));
      return { ok: true };
    });

    envApi.get("/api/environments", async (req) => {
      const rows = await db
        .select({ env: environments, role: memberships.role })
        .from(memberships)
        .innerJoin(environments, eq(memberships.environmentId, environments.id))
        .where(and(eq(memberships.userId, req.user!.id), isNull(environments.deletedAt)))
        .orderBy(environments.createdAt);
      return rows.map((r) => envSummary(r.env, r.role, gateway, hub));
    });

    envApi.post("/api/environments", async (req, reply) => {
      const body = envCreateSchema.parse(req.body ?? {});
      const owned = await db
        .select({ n: sql<number>`count(*)` })
        .from(memberships)
        .innerJoin(environments, eq(memberships.environmentId, environments.id))
        .where(
          and(
            eq(memberships.userId, req.user!.id),
            eq(memberships.role, "owner"),
            isNull(environments.deletedAt),
          ),
        );
      if (Number(owned[0]?.n ?? 0) >= config.maxEnvironmentsPerUser) {
        return reply.code(403).send({
          error: `environment limit reached (${config.maxEnvironmentsPerUser})`,
        });
      }
      const direct = body.sourceType === "direct";
      const viaAgent = body.sourceType === "agent";
      if (direct || viaAgent) {
        const taken = await db
          .select({ id: environments.id })
          .from(environments)
          .where(and(eq(environments.loggerSerial, body.loggerSerial!), isNull(environments.deletedAt)));
        if (taken.length > 0) {
          return reply.code(409).send({ error: "this serial is already linked to another environment" });
        }
      }
      if (viaAgent && !(await ownedAgent(req.user!.id, body.agentId!))) {
        return reply.code(404).send({ error: "unknown agent" });
      }
      const [row] = await db
        .insert(environments)
        .values({
          name: body.name,
          timezone: body.timezone,
          lat: body.lat,
          lon: body.lon,
          sourceType: body.sourceType,
          inverterIp: direct ? body.inverterIp : null,
          inverterPort: direct ? (body.inverterPort ?? 8899) : null,
          loggerSerial: direct || viaAgent ? body.loggerSerial : null,
          agentId: viaAgent ? body.agentId : null,
          createdBy: req.user!.id,
        })
        .returning();
      await db
        .insert(memberships)
        .values({ userId: req.user!.id, environmentId: row.id, role: "owner" });
      // The agent may already see the stick: start polling right away.
      if (viaAgent) await hub.tryAttach(body.agentId!, body.loggerSerial!);
      return reply.code(201).send(envSummary(row, "owner", gateway, hub));
    });

    /** Probe a stick before creating the environment (wizard "Test connection"). */
    envApi.post("/api/environments/test-connection", async (req) => {
      const body = connectionSchema.parse(req.body ?? {});
      return testDirectConnection(body.ip, body.port, body.serial);
    });
  });

  // ------------------------------------------------- env-scoped: management

  app.register(async (scoped) => {
    scoped.addHook("preHandler", auth.authenticate);
    scoped.addHook("preHandler", auth.authorizeEnv("viewer"));

    scoped.get("/", async (req) => envSummary(req.envAccess!.env, req.envAccess!.role, gateway, hub));

    scoped.patch("/", { preHandler: auth.authorizeEnv("installer") }, async (req) => {
      const patch = envPatchSchema.parse(req.body ?? {});
      const envId = req.envAccess!.env.id;
      if (Object.keys(patch).length > 0) {
        await db.update(environments).set(patch).where(eq(environments.id, envId));
        // Rebuild the runtime so timezone/location changes take effect.
        await manager.invalidate(envId);
        const serial = req.envAccess!.env.loggerSerial;
        if (serial !== null && gateway) await gateway.tryAttach(serial);
      }
      const row = await manager.getEnvRow(envId);
      return envSummary(row!, req.envAccess!.role, gateway, hub);
    });

    scoped.delete("/", { preHandler: auth.authorizeEnv("owner") }, async (req) => {
      const envId = req.envAccess!.env.id;
      await db
        .update(environments)
        .set({ deletedAt: new Date(), loggerSerial: null })
        .where(eq(environments.id, envId));
      await manager.invalidate(envId);
      return { ok: true };
    });

    scoped.get("/logger", async (req) => {
      const env = req.envAccess!.env;
      const candidates =
        env.loggerSerial === null && gateway ? gateway.unclaimedForIp(req.ip) : [];
      return {
        serial: env.loggerSerial,
        connected: stickConnected(env, gateway, hub),
        lastSeenAt: env.loggerLastSeenAt?.toISOString() ?? null,
        candidates,
        server: { host: config.publicLoggerHost, port: config.publicLoggerPort },
      };
    });

    scoped.post("/logger/claim", { preHandler: auth.authorizeEnv("installer") }, async (req, reply) => {
      const env = req.envAccess!.env;
      if (env.sourceType !== "gateway") {
        return reply.code(400).send({ error: "this environment has no logger" });
      }
      const { serial } = serialSchema.parse(req.body ?? {});
      const taken = await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.loggerSerial, serial), isNull(environments.deletedAt)));
      if (taken.length > 0 && taken[0].id !== env.id) {
        return reply.code(409).send({ error: "this serial is already claimed" });
      }
      await db
        .update(environments)
        .set({ loggerSerial: serial })
        .where(eq(environments.id, env.id));
      await manager.invalidate(env.id);
      const connected = gateway ? await gateway.tryAttach(serial) : false;
      return { serial, connected };
    });

    // ------------------------------------- direct connection (owner-only)

    scoped.get("/connection", { preHandler: auth.authorizeEnv("owner") }, async (req, reply) => {
      const env = req.envAccess!.env;
      if (env.sourceType !== "direct") {
        return reply.code(404).send({ error: "not a direct environment" });
      }
      return { ip: env.inverterIp, port: env.inverterPort ?? 8899, serial: env.loggerSerial };
    });

    scoped.put("/connection", { preHandler: auth.authorizeEnv("owner") }, async (req, reply) => {
      const env = req.envAccess!.env;
      if (env.sourceType !== "direct") {
        return reply.code(404).send({ error: "not a direct environment" });
      }
      const body = connectionSchema.parse(req.body ?? {});
      const taken = await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.loggerSerial, body.serial), isNull(environments.deletedAt)));
      if (taken.length > 0 && taken[0].id !== env.id) {
        return reply.code(409).send({ error: "this serial is already linked to another environment" });
      }
      await db
        .update(environments)
        .set({ inverterIp: body.ip, inverterPort: body.port, loggerSerial: body.serial })
        .where(eq(environments.id, env.id));
      // Rebuild the runtime so polling restarts against the new address.
      await manager.invalidate(env.id);
      return { ip: body.ip, port: body.port, serial: body.serial };
    });

    // ------------------------------------------- change data source (owner-only)

    scoped.put("/source", { preHandler: auth.authorizeEnv("owner") }, async (req, reply) => {
      const env = req.envAccess!.env;
      if (env.sourceType === "simulator") {
        return reply.code(400).send({ error: "demo environments have no data source to change" });
      }
      const body = sourceSwitchSchema.parse(req.body ?? {});

      if (body.sourceType === "direct" || body.sourceType === "agent") {
        const taken = await db
          .select({ id: environments.id })
          .from(environments)
          .where(and(eq(environments.loggerSerial, body.serial), isNull(environments.deletedAt)));
        if (taken.length > 0 && taken[0].id !== env.id) {
          return reply.code(409).send({ error: "this serial is already linked to another environment" });
        }
      }

      if (body.sourceType === "direct") {
        await db
          .update(environments)
          .set({
            sourceType: "direct",
            inverterIp: body.ip,
            inverterPort: body.port,
            loggerSerial: body.serial,
            agentId: null,
          })
          .where(eq(environments.id, env.id));
      } else if (body.sourceType === "agent") {
        if (!(await ownedAgent(req.user!.id, body.agentId))) {
          return reply.code(404).send({ error: "unknown agent" });
        }
        await db
          .update(environments)
          .set({
            sourceType: "agent",
            agentId: body.agentId,
            loggerSerial: body.serial,
            inverterIp: null,
            inverterPort: null,
          })
          .where(eq(environments.id, env.id));
      } else {
        // Back to the stick connecting to us: keep the serial (so the claim
        // stays), drop the LAN address and the agent.
        await db
          .update(environments)
          .set({ sourceType: "gateway", inverterIp: null, inverterPort: null, agentId: null })
          .where(eq(environments.id, env.id));
      }

      // Rebuild the runtime: direct polls on its own; gateway/agent wait for the stick.
      await manager.invalidate(env.id);
      const row = await manager.getEnvRow(env.id);
      if (body.sourceType === "gateway" && row?.loggerSerial != null && gateway) {
        await gateway.tryAttach(row.loggerSerial); // the stick may already be connected
      }
      if (body.sourceType === "agent") {
        await hub.tryAttach(body.agentId, body.serial); // the agent may already see it
      }
      return envSummary(row!, req.envAccess!.role, gateway, hub);
    });

    scoped.post("/connection/test", { preHandler: auth.authorizeEnv("owner") }, async (req) => {
      const body = connectionSchema.parse(req.body ?? {});
      return testDirectConnection(body.ip, body.port, body.serial);
    });

    // ------------------------------------------------- members (sharing)
    // A stick/environment is shared by granting other accounts a membership;
    // every member sees the same data under their own login.

    scoped.get("/members", async (req) => {
      const rows = await db
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.environmentId, req.envAccess!.env.id))
        .orderBy(memberships.createdAt);
      return rows.map((r) => ({ ...r, me: r.userId === req.user!.id }));
    });

    scoped.post("/members", { preHandler: auth.authorizeEnv("owner") }, async (req, reply) => {
      const body = memberAddSchema.parse(req.body ?? {});
      const envId = req.envAccess!.env.id;
      const [target] = await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(sql`lower(${users.email}) = ${body.email}`);
      if (!target) {
        return reply.code(404).send({ error: "no account with that email — ask them to sign up first" });
      }
      const existing = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, target.id), eq(memberships.environmentId, envId)));
      if (existing.length > 0) {
        return reply.code(409).send({ error: "that account is already a member" });
      }
      await db
        .insert(memberships)
        .values({ userId: target.id, environmentId: envId, role: body.role });
      return reply.code(201).send({
        userId: target.id,
        email: target.email,
        displayName: target.displayName,
        role: body.role,
        me: false,
      });
    });

    scoped.patch("/members/:userId", { preHandler: auth.authorizeEnv("owner") }, async (req, reply) => {
      const targetId = memberIdSchema.parse((req.params as { userId: string }).userId);
      const { role } = memberPatchSchema.parse(req.body ?? {});
      const envId = req.envAccess!.env.id;
      const [m] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, targetId), eq(memberships.environmentId, envId)));
      if (!m) return reply.code(404).send({ error: "not a member" });
      if (m.role === "owner") {
        return reply.code(400).send({ error: "the owner's role cannot be changed" });
      }
      await db
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.userId, targetId), eq(memberships.environmentId, envId)));
      return { userId: targetId, role };
    });

    // Owners remove members; any non-owner member may remove themselves (leave).
    scoped.delete("/members/:userId", async (req, reply) => {
      const targetId = memberIdSchema.parse((req.params as { userId: string }).userId);
      const envId = req.envAccess!.env.id;
      const self = targetId === req.user!.id;
      if (!self && req.envAccess!.role !== "owner") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const [m] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, targetId), eq(memberships.environmentId, envId)));
      if (!m) return reply.code(404).send({ error: "not a member" });
      if (m.role === "owner") {
        return reply.code(400).send({ error: "the owner cannot be removed" });
      }
      await db
        .delete(memberships)
        .where(and(eq(memberships.userId, targetId), eq(memberships.environmentId, envId)));
      return { ok: true };
    });
  }, { prefix: "/api/environments/:envId" });

  // ------------------------------------------------------- env-scoped: data

  app.register(async (scoped) => {
    scoped.addHook("preHandler", auth.authenticate);
    scoped.addHook("preHandler", auth.authorizeEnv("viewer"));

    const writeGuard = { preHandler: auth.authorizeEnv("installer") };

    const runtime = async (req: FastifyRequest, reply: FastifyReply): Promise<EnvironmentRuntime | null> => {
      const rt = await manager.get(req.envAccess!.env.id);
      if (!rt) {
        void reply.code(404).send({ error: "not found" });
        return null;
      }
      return rt;
    };

    // -------------------------------------------------------------- config

    scoped.get("/config", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const env = rt.env;
      return {
        ...rt.inverterConfig,
        simulate: env.sourceType === "simulator",
        sourceType: env.sourceType,
        pollIntervalMs: (rt.settings.get().pollIntervalS ?? config.pollIntervalMs / 1000) * 1000,
        version: APP_VERSION,
        timezone: env.timezone,
        location: { lat: env.lat, lon: env.lon },
        logger: {
          serial: env.loggerSerial,
          connected: stickConnected(env, gateway, hub),
          lastSeenAt: env.loggerLastSeenAt?.toISOString() ?? null,
        },
      };
    });

    // ---------------------------------------------------------------- live

    scoped.get("/live", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const snap = rt.liveState.current;
      if (!snap) {
        const env = rt.env;
        return reply.code(503).send({
          error: "not yet available",
          loggerConnected: stickConnected(env, gateway, hub),
          loggerLastSeenAt: env.loggerLastSeenAt?.toISOString() ?? null,
        });
      }
      return { ...snap, outage: rt.outageTracker.status };
    });

    // ------------------------------------------------------------- history

    scoped.get("/history/day", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
        .parse(req.query);
      return rt.analytics.day(q.date ?? localDateKey(new Date(), rt.tz));
    });

    scoped.get("/history/month", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })
        .parse(req.query);
      const month = q.month ?? localDateKey(new Date(), rt.tz).slice(0, 7);
      const data = await rt.analytics.month(month);
      const savings = computeSavings(data.days, rt.settings.get());
      return { ...data, savings };
    });

    scoped.get("/history/year", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ year: z.coerce.number().int().min(2000).max(2100).optional() })
        .parse(req.query);
      return rt.analytics.year(q.year ?? new Date().getFullYear());
    });

    scoped.get("/history/lifetime", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      return rt.analytics.lifetime(rt.settings.get());
    });

    scoped.get("/history/range", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .parse(req.query);
      const rows = await rt.analytics.dailyRange(q.from, q.to);
      return { from: q.from, to: q.to, days: rows, totals: totalsFor(rows) };
    });

    // ------------------------------------------------------------- battery

    scoped.get("/battery/stats", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ days: z.coerce.number().int().min(1).max(400).default(30) })
        .parse(req.query);
      const snap = rt.liveState.current;
      return rt.analytics.batteryStats(
        q.days,
        rt.settings.get(),
        snap?.soc ?? null,
        snap?.loadW ?? null,
      );
    });

    scoped.get("/battery/series", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
        .parse(req.query);
      return { hours: q.hours, series: await rt.analytics.batterySeries(q.hours) };
    });

    // ---------------------------------------------------------------- grid

    scoped.get("/grid/quality", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
        .parse(req.query);
      return rt.analytics.gridQuality(q.hours);
    });

    scoped.get("/outages", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ days: z.coerce.number().int().min(1).max(400).default(90) })
        .parse(req.query);
      const data = await rt.analytics.outages(q.days);
      return { ...data, current: rt.outageTracker.status };
    });

    // ----------------------------------------------------------- generator

    scoped.get("/generator", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      if (!rt.inverterConfig.hasGenerator) return { enabled: false };
      const q = z
        .object({ days: z.coerce.number().int().min(1).max(400).default(30) })
        .parse(req.query);
      const snap = rt.liveState.current;
      return rt.analytics.generator(
        q.days,
        rt.settings.get(),
        rt.generatorTracker.isRunning,
        snap?.genW ?? 0,
      );
    });

    // ------------------------------------------------------------- weather

    scoped.get("/weather", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const data = rt.weather.data;
      if (!data) return reply.code(503).send({ error: "not yet available" });
      return { current: data.current, daily: data.daily, warnings: data.warnings, fetchedAt: data.fetchedAt };
    });

    scoped.get("/forecast", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const calibration = await rt.weather.calibrationFactor();
      const hourly = rt.weather.hourlyPvForecast(calibration);
      const history = await rt.analytics.weatherHistory(30);
      const dailyForecasts = (rt.weather.data?.daily ?? [])
        .map((d) => rt.weather.forecastForDate(d.date, calibration))
        .filter((d): d is { date: string; forecastKwh: number } => d !== null);
      return {
        calibration,
        hourly,
        daily: dailyForecasts,
        history: history.map((h) => ({
          date: h.date,
          forecastPvKwh: h.forecastPvKwh,
          actualPvKwh: h.actualPvKwh,
          weatherCode: h.weatherCode,
        })),
      };
    });

    // ------------------------------------------------------------- savings

    scoped.get("/savings", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({
          period: z.enum(["month", "year", "lifetime"]).default("month"),
          month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
          year: z.coerce.number().int().optional(),
        })
        .parse(req.query);
      const s = rt.settings.get();
      const today = localDateKey(new Date(), rt.tz);

      let from: string;
      let to: string = today;
      if (q.period === "month") {
        const ym = q.month ?? today.slice(0, 7);
        from = `${ym}-01`;
        const [y, m] = ym.split("-").map(Number);
        to = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
      } else if (q.period === "year") {
        const y = q.year ?? new Date().getFullYear();
        from = `${y}-01-01`;
        to = `${y}-12-31`;
      } else {
        from = "2000-01-01";
      }

      const rows = await rt.analytics.dailyRange(from, to);
      const savings = computeSavings(rows, s);
      const monthly = new Map<string, typeof rows>();
      for (const r of rows) {
        const key = r.date.slice(0, 7);
        if (!monthly.has(key)) monthly.set(key, []);
        monthly.get(key)!.push(r);
      }
      return {
        period: q.period,
        from,
        to,
        ...savings,
        systemCost: s.systemCost,
        paybackPct:
          s.systemCost > 0 && q.period === "lifetime"
            ? Math.min(100, Math.round((savings.totalSaved / s.systemCost) * 100))
            : null,
        monthly: [...monthly.entries()].map(([month, monthRows]) => ({
          month,
          ...computeSavings(monthRows, s),
        })),
      };
    });

    // ------------------------------------------------------------ insights

    scoped.get("/insights", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const insights: { icon: string; title: string; text: string; tone: "good" | "info" | "warn" }[] = [];
      const s = rt.settings.get();
      const snap = rt.liveState.current;
      const today = localDateKey(new Date(), rt.tz);
      const ym = today.slice(0, 7);

      // Severe-weather warnings come first — they are the most actionable.
      const warnings = rt.weather.data?.warnings ?? [];
      for (const w of warnings.slice(0, 2)) {
        insights.push({
          icon: w.kind === "wind" ? "wind" : "storm",
          title: w.title,
          text: w.text,
          tone: "warn",
        });
      }
      if (warnings.length > 0) {
        insights.push({
          icon: "battery",
          title: "Storm prep",
          text: "Severe weather ahead — consider charging the battery to full before it hits.",
          tone: "info",
        });
      }

      // Yesterday well under its forecast? Probably dirt, shading or a fault.
      try {
        const yesterday = localDateKey(new Date(Date.now() - 86400000), rt.tz);
        const [yw] = await db
          .select({ forecast: dailyWeather.forecastPvKwh, actual: dailyWeather.actualPvKwh })
          .from(dailyWeather)
          .where(and(eq(dailyWeather.environmentId, rt.env.id), eq(dailyWeather.date, yesterday)));
        if (
          yw?.forecast != null &&
          yw.actual != null &&
          yw.forecast > 2 &&
          yw.actual < yw.forecast * PV_UNDERPERFORMANCE_FACTOR
        ) {
          insights.push({
            icon: "sun",
            title: "Production below forecast",
            text: `Yesterday made ${yw.actual.toFixed(1)} kWh vs ~${yw.forecast.toFixed(1)} kWh expected — panels dirty or shaded?`,
            tone: "warn",
          });
        }
      } catch { /* no weather history yet */ }

      try {
        const month = await rt.analytics.month(ym);
        const t = month.totals;
        const p = month.prevTotals;
        if (t.pvKwh > 0 && p.pvKwh > 0) {
          const avgNow = t.pvKwh / Math.max(1, t.days);
          const avgPrev = p.pvKwh / Math.max(1, p.days);
          const deltaPct = Math.round(((avgNow - avgPrev) / avgPrev) * 100);
          if (Math.abs(deltaPct) >= 5) {
            insights.push({
              icon: "trending",
              title: `Production ${deltaPct > 0 ? "up" : "down"} ${Math.abs(deltaPct)}%`,
              text: `Daily average is ${avgNow.toFixed(1)} kWh vs ${avgPrev.toFixed(1)} kWh last month.`,
              tone: deltaPct > 0 ? "good" : "info",
            });
          }
        }
        if (t.selfSufficiencyPct !== null) {
          insights.push({
            icon: "shield",
            title: `${t.selfSufficiencyPct}% self-sufficient this month`,
            text: `${t.loadKwh.toFixed(0)} kWh consumed, only ${t.importKwh.toFixed(0)} kWh imported.`,
            tone: t.selfSufficiencyPct >= 70 ? "good" : "info",
          });
        }
        if (month.bestDay) {
          insights.push({
            icon: "sun",
            title: `Best day: ${month.bestDay.pvKwh.toFixed(1)} kWh`,
            text: `On ${month.bestDay.date}.`,
            tone: "good",
          });
        }
        const savings = computeSavings(month.days, s);
        if (savings.totalSaved > 0) {
          insights.push({
            icon: "coins",
            title: `Saved ~${savings.totalSaved.toFixed(0)} ${s.currency} this month`,
            text: `${savings.avoidedImportCost.toFixed(0)} avoided imports + ${savings.exportRevenue.toFixed(0)} export revenue.`,
            tone: "good",
          });
        }
      } catch { /* not enough data yet */ }

      try {
        const calibration = await rt.weather.calibrationFactor();
        const tomorrow = localDateKey(new Date(Date.now() + 86400000), rt.tz);
        const fc = rt.weather.forecastForDate(tomorrow, calibration);
        if (fc && fc.forecastKwh > 0) {
          insights.push({
            icon: "cloud-sun",
            title: `Tomorrow: ~${fc.forecastKwh.toFixed(1)} kWh expected`,
            text: fc.forecastKwh > 15
              ? "Great day to run the washing machine and dishwasher."
              : "Modest production expected — heavy loads are better left for a sunnier day.",
            tone: "info",
          });
        }
      } catch { /* ignore */ }

      if (snap?.chargeEstimate?.status === "charging" && snap.chargeEstimate.etaClock) {
        insights.push({
          icon: "battery",
          title: `Battery full around ${snap.chargeEstimate.etaClock}`,
          text: `Charging at ${Math.round(snap.chargeEstimate.powerW)} W.`,
          tone: "info",
        });
      }

      return insights.slice(0, 6);
    });

    // -------------------------------------------------------------- alerts

    scoped.get("/alerts", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          unread: z.coerce.boolean().default(false),
        })
        .parse(req.query);
      return {
        alerts: await rt.analytics.alerts(q.limit, q.unread),
        unreadCount: await rt.analytics.unreadCount(),
      };
    });

    scoped.post("/alerts/read", writeGuard, async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const body = z
        .object({ ids: z.union([z.literal("all"), z.array(z.number().int())]) })
        .parse(req.body ?? {});
      await rt.analytics.markAlertsRead(body.ids);
      return { ok: true, unreadCount: await rt.analytics.unreadCount() };
    });

    // -------------------------------------------------------------- tariff

    scoped.post("/tariff/backfill", writeGuard, async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      return rt.analytics.backfillImportSlots();
    });

    // -------------------------------------------------------- ac coupling

    scoped.post("/ac-coupling/backfill", writeGuard, async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      return rt.analytics.backfillAcCoupling();
    });

    // ------------------------------------------------- dashboard layout
    // Each member arranges their own dashboard; viewers included, since the
    // layout only affects what they see, never the environment itself.

    scoped.get("/layout", async (req, reply) => {
      const [row] = await db
        .select({ layout: dashboardLayouts.layout })
        .from(dashboardLayouts)
        .where(
          and(
            eq(dashboardLayouts.environmentId, req.envAccess!.env.id),
            eq(dashboardLayouts.userId, req.user!.id),
          ),
        );
      if (!row) return reply.code(404).send({ error: "no saved layout" });
      return row.layout;
    });

    scoped.put("/layout", async (req) => {
      const layout = layoutSchema.parse(req.body ?? {}) as DashboardLayout;
      await db
        .insert(dashboardLayouts)
        .values({
          environmentId: req.envAccess!.env.id,
          userId: req.user!.id,
          layout,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dashboardLayouts.environmentId, dashboardLayouts.userId],
          set: { layout, updatedAt: new Date() },
        });
      return layout;
    });

    // ------------------------------------------------------------ settings

    scoped.get("/settings", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      return rt.settings.get();
    });

    scoped.put("/settings", writeGuard, async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const patch = appSettingsSchema.partial().parse(req.body ?? {}) as Partial<AppSettings>;
      const before = rt.settings.get();
      const updated = await rt.settings.update(patch);
      // Refresh weather so tilt/azimuth/kWp changes take effect promptly.
      void rt.weather.fetchNow();
      // Reconnect the MQTT export only when its settings actually changed.
      const mqttKeys = [
        "mqttEnabled", "mqttUrl", "mqttUsername", "mqttPassword", "mqttTopicPrefix", "mqttHaDiscovery",
      ] as const;
      if (mqttKeys.some((k) => before[k] !== updated[k])) rt.mqtt.apply(updated);
      return updated;
    });

    /** Connection status for the Integrations card. */
    scoped.get("/integrations/mqtt", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      return rt.mqtt.status;
    });

    // -------------------------------------------------------------- export

    scoped.get("/export.csv", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
        .parse(req.query);
      const from = q.from ?? "2000-01-01";
      const to = q.to ?? localDateKey(new Date(), rt.tz);
      const rows = await rt.analytics.dailyRange(from, to);
      const header =
        "date,pv_kwh,import_kwh,export_kwh,load_kwh,batt_charge_kwh,batt_discharge_kwh,gen_kwh," +
        "pv_to_load_kwh,pv_to_batt_kwh,pv_to_grid_kwh,grid_to_load_kwh,grid_to_batt_kwh,batt_to_load_kwh," +
        "peak_pv_w,peak_load_w,soc_min,soc_max";
      const lines = rows.map((r) =>
        [
          r.date, r.pvKwh, r.importKwh, r.exportKwh, r.loadKwh,
          r.battChargeKwh, r.battDischargeKwh, r.genKwh,
          r.pvToLoadKwh, r.pvToBattKwh, r.pvToGridKwh,
          r.gridToLoadKwh, r.gridToBattKwh, r.battToLoadKwh,
          r.peakPvW, r.peakLoadW, r.socMin ?? "", r.socMax ?? "",
        ].join(","),
      );
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="deye-energy-${from}-${to}.csv"`);
      return [header, ...lines].join("\n");
    });
  }, { prefix: "/api/environments/:envId" });

  // ------------------------------------------- env-scoped: inverter settings
  registerInverterRoutes(app, deps);
}
