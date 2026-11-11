/**
 * Inverter settings API: read and (guarded) write the inverter's own
 * configuration registers. Writes require the installer role, the
 * INVERTER_WRITES_ENABLED kill switch, a 1-phase inverter and an online
 * data source. Every write attempt is audit-logged in inverter_changes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { inverterChanges, inverterProfiles, users } from "../db/schema.js";
import type { EnvironmentRuntime } from "../runtime/environment.js";
import { SettingsValidationError, type ClockParts } from "../inverter/settingsMap.js";
import type { ApiDeps } from "./routes.js";

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

const touSlotSchema = z
  .object({
    time: z.string().regex(timeRe),
    powerW: z.number().int().min(0),
    capacityPct: z.number().int().min(0).max(100),
    voltageV: z.number().min(40).max(61),
    charge: z.enum(["none", "grid", "gen", "gridGen"]),
    mode: z.enum(["none", "general", "backup", "charge"]),
    sell: z.boolean(),
  })
  .partial()
  .strict();

/** Loose numeric bounds here; the settings map enforces the exact ranges. */
const patchSchema = z
  .object({
    priorityLoad: z.boolean(),
    loadLimit: z.enum(["allowExport", "essentials", "zeroExport"]),
    solarSell: z.boolean(),
    maxSellPowerW: z.number().int().min(0),
    maxSolarPowerW: z.number().int().min(0),
    battMaxChargeA: z.number().int().min(0).max(185),
    battMaxDischargeA: z.number().int().min(0).max(185),
    gridChargeA: z.number().int().min(0).max(185),
    gridChargeEnabled: z.boolean(),
    battShutdownPct: z.number().int().min(0).max(100),
    battRestartPct: z.number().int().min(0).max(100),
    battLowPct: z.number().int().min(0).max(100),
    useTimer: z.boolean(),
    touSlots: z.array(touSlotSchema.nullable()).max(6),
    battShutdownV: z.number().min(40).max(61),
    battRestartV: z.number().min(40).max(61),
    battLowV: z.number().min(40).max(61),
    battEqualizationV: z.number().min(40).max(61),
    battAbsorptionV: z.number().min(40).max(61),
    battFloatV: z.number().min(40).max(61),
    bmsProtocol: z.number().int().min(0).max(19),
    auxPort: z.enum(["disable", "smartload", "generator"]),
    gridTrickleFeedW: z.number().int().min(-500).max(500),
    peakShaving: z.boolean(),
    genPeakShaving: z.boolean(),
    gridPeakShaving: z.boolean(),
    genPeakShavingW: z.number().int().min(0),
    gridPeakShavingW: z.number().int().min(0),
    inverterEnabled: z.boolean(),
  })
  .partial()
  .strict();

/**
 * What a saved profile may contain: the safe operational fields only.
 * Hardware protection (voltages, BMS, AUX, peak shaving, trickle) and the
 * inverter on/off switch are deliberately not storable in profiles.
 */
const profileSettingsSchema = patchSchema.omit({
  battShutdownV: true,
  battRestartV: true,
  battLowV: true,
  battEqualizationV: true,
  battAbsorptionV: true,
  battFloatV: true,
  bmsProtocol: true,
  auxPort: true,
  gridTrickleFeedW: true,
  peakShaving: true,
  genPeakShaving: true,
  gridPeakShaving: true,
  genPeakShavingW: true,
  gridPeakShavingW: true,
  inverterEnabled: true,
});

const profileBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  settings: profileSettingsSchema,
});

/** Current wall-clock parts in the environment's timezone. */
export function clockPartsNow(tz: string | undefined, now = new Date()): ClockParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // en-GB can render midnight as "24"
    minute: get("minute"),
    second: get("second"),
  };
}

export function registerInverterRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, manager, auth } = deps;

  app.register(async (scoped) => {
    scoped.addHook("preHandler", auth.authenticate);
    scoped.addHook("preHandler", auth.authorizeEnv("viewer"));

    const writeGuard = { preHandler: auth.authorizeEnv("installer") };

    const runtime = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<EnvironmentRuntime | null> => {
      const rt = await manager.get(req.envAccess!.env.id);
      if (!rt) {
        void reply.code(404).send({ error: "not found" });
        return null;
      }
      return rt;
    };

    /**
     * Gate common to all write endpoints. Returns the runtime or null after
     * sending the error response.
     */
    const writableRuntime = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<EnvironmentRuntime | null> => {
      const rt = await runtime(req, reply);
      if (!rt) return null;
      if (!config.inverterWritesEnabled) {
        void reply.code(403).send({ error: "inverter writes are disabled on this server" });
        return null;
      }
      if (rt.inverterConfig.phases !== 1) {
        void reply.code(409).send({ error: "settings writes are only supported on 1-phase inverters" });
        return null;
      }
      if (!rt.control) {
        void reply.code(409).send({ error: "inverter is offline" });
        return null;
      }
      return rt;
    };

    const audit = async (
      envId: string,
      userId: number,
      fields: { field: string; from: unknown; to: unknown; ok: boolean; error?: string }[],
      ok: boolean,
      error: string | null,
    ) => {
      try {
        await db.insert(inverterChanges).values({ environmentId: envId, userId, fields, ok, error });
      } catch {
        /* the audit log must never break the response */
      }
    };

    // ------------------------------------------------------------------ read

    scoped.get("/settings", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const base = {
        writesEnabled: config.inverterWritesEnabled,
        phases: rt.inverterConfig.phases,
      };
      if (rt.inverterConfig.phases !== 1) {
        return { ...base, supported: false, online: rt.control !== null, reason: "threePhase" };
      }
      if (!rt.control) {
        return { ...base, supported: true, online: false, reason: "offline" };
      }
      try {
        const read = await rt.control.readSettings();
        return { ...base, supported: true, online: true, ...read };
      } catch (err) {
        return { ...base, supported: true, online: false, reason: (err as Error).message };
      }
    });

    // ----------------------------------------------------------------- write

    scoped.put("/settings", writeGuard, async (req, reply) => {
      const rt = await writableRuntime(req, reply);
      if (!rt) return reply;
      const patch = patchSchema.parse(req.body ?? {});
      const envId = rt.env.id;
      const userId = req.user!.id;

      try {
        const result = await rt.control!.applySettings(patch);
        await audit(
          envId,
          userId,
          result.results.map((r) => ({
            field: r.key, from: r.from, to: r.to, ok: r.ok,
            ...(r.error ? { error: r.error } : {}),
          })),
          result.ok,
          null,
        );
        return { ...result, writesEnabled: true };
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          return reply.code(400).send({ error: err.message, issues: err.issues });
        }
        // Transport failure mid-apply: audit the attempt, report upstream.
        await audit(envId, userId, [], false, (err as Error).message);
        return reply.code(502).send({ error: `inverter write failed: ${(err as Error).message}` });
      }
    });

    /** Set the inverter clock to the environment's current local time. */
    scoped.post("/clock", writeGuard, async (req, reply) => {
      const rt = await writableRuntime(req, reply);
      if (!rt) return reply;
      const parts = clockPartsNow(rt.tz);
      try {
        await rt.control!.setClock(parts);
        const p = (n: number) => String(n).padStart(2, "0");
        const value =
          `${parts.year}-${p(parts.month)}-${p(parts.day)} ` +
          `${p(parts.hour)}:${p(parts.minute)}:${p(parts.second)}`;
        await audit(
          rt.env.id,
          req.user!.id,
          [{ field: "clock", from: null, to: value, ok: true }],
          true,
          null,
        );
        return { ok: true, clock: value };
      } catch (err) {
        await audit(rt.env.id, req.user!.id, [], false, (err as Error).message);
        return reply.code(502).send({ error: `clock write failed: ${(err as Error).message}` });
      }
    });

    // ----------------------------------------------------------------- audit

    scoped.get("/changes", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const q = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
        .parse(req.query);
      const rows = await db
        .select({
          id: inverterChanges.id,
          ts: inverterChanges.ts,
          fields: inverterChanges.fields,
          ok: inverterChanges.ok,
          error: inverterChanges.error,
          userEmail: users.email,
          userName: users.displayName,
        })
        .from(inverterChanges)
        .leftJoin(users, eq(inverterChanges.userId, users.id))
        .where(eq(inverterChanges.environmentId, rt.env.id))
        .orderBy(desc(inverterChanges.ts), desc(inverterChanges.id))
        .limit(q.limit);
      return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
    });

    // -------------------------------------------------------------- profiles
    // Saved configurations are plain data: applying one goes through the
    // normal guarded PUT /settings, so no runtime/kill-switch gate here.

    const profileRow = (r: typeof inverterProfiles.$inferSelect) => ({
      id: r.id,
      name: r.name,
      settings: r.settings,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });

    scoped.get("/profiles", async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const rows = await db
        .select()
        .from(inverterProfiles)
        .where(eq(inverterProfiles.environmentId, rt.env.id))
        .orderBy(asc(inverterProfiles.name));
      return rows.map(profileRow);
    });

    scoped.post("/profiles", writeGuard, async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const body = profileBodySchema.parse(req.body ?? {});
      const clash = await db
        .select({ id: inverterProfiles.id })
        .from(inverterProfiles)
        .where(and(eq(inverterProfiles.environmentId, rt.env.id), eq(inverterProfiles.name, body.name)));
      if (clash.length) {
        return reply.code(409).send({ error: "a profile with that name already exists" });
      }
      const [row] = await db
        .insert(inverterProfiles)
        .values({ environmentId: rt.env.id, name: body.name, settings: body.settings })
        .returning();
      return reply.code(201).send(profileRow(row));
    });

    scoped.put("/profiles/:profileId", writeGuard, async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const { profileId } = z.object({ profileId: z.coerce.number().int() }).parse(req.params);
      const body = profileBodySchema.partial().strict().parse(req.body ?? {});
      if (body.name !== undefined) {
        const clash = await db
          .select({ id: inverterProfiles.id })
          .from(inverterProfiles)
          .where(and(
            eq(inverterProfiles.environmentId, rt.env.id),
            eq(inverterProfiles.name, body.name),
            ne(inverterProfiles.id, profileId),
          ));
        if (clash.length) {
          return reply.code(409).send({ error: "a profile with that name already exists" });
        }
      }
      const [row] = await db
        .update(inverterProfiles)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.settings !== undefined ? { settings: body.settings } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(inverterProfiles.id, profileId), eq(inverterProfiles.environmentId, rt.env.id)))
        .returning();
      if (!row) return reply.code(404).send({ error: "not found" });
      return profileRow(row);
    });

    scoped.delete("/profiles/:profileId", writeGuard, async (req, reply) => {
      const rt = await runtime(req, reply);
      if (!rt) return reply;
      const { profileId } = z.object({ profileId: z.coerce.number().int() }).parse(req.params);
      const rows = await db
        .delete(inverterProfiles)
        .where(and(eq(inverterProfiles.id, profileId), eq(inverterProfiles.environmentId, rt.env.id)))
        .returning({ id: inverterProfiles.id });
      if (!rows.length) return reply.code(404).send({ error: "not found" });
      return { ok: true };
    });
  }, { prefix: "/api/environments/:envId/inverter" });
}
