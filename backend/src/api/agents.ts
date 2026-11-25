import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, environments } from "../db/schema.js";
import type { AuthHooks } from "../auth/plugin.js";
import type { AgentHub } from "../agent/hub.js";
import { generateAgentToken, hashAgentToken, PairingStore } from "../agent/pairing.js";
import { DeyeInverter } from "../inverter/reader.js";

export interface AgentApiDeps {
  db: Db;
  auth: AuthHooks;
  hub: AgentHub;
  pairing: PairingStore;
}

const pairStartSchema = z.object({
  name: z.string().trim().min(1).max(60),
  platform: z.enum(["windows", "macos", "linux"]).or(z.string().max(20)),
  /** Re-pairing: the id this device was paired as before (lost token). */
  previousAgentId: z.string().uuid().optional(),
});

const pairPollSchema = z.object({
  deviceCode: z.string().min(32).max(128),
});

const userCodeSchema = z.object({
  code: z.string().min(4).max(16),
});

const renameSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

const testSchema = z.object({
  serial: z.number().int().min(1).max(0xffffffff),
});

/**
 * HTTPS enforcement for the agent credential endpoints (AGENT_REQUIRE_TLS).
 * `req.protocol` already honours X-Forwarded-Proto because the server runs
 * with trustProxy. Defense in depth — the agent refuses plain HTTP anyway.
 */
export function agentTlsGuard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.agentRequireTls) return true;
  if (req.protocol === "https") return true;
  void reply.code(426).send({ error: "agent endpoints require https" });
  return false;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentApiDeps): void {
  const { db, auth, hub, pairing } = deps;

  // ------------------------------------------------ pairing (agent side)
  // Unauthenticated by design (the agent has no credentials yet), tightly
  // rate-limited, and only ever returns a token after a user approved the
  // code from their logged-in browser session.

  app.post(
    "/api/agent/pair/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!agentTlsGuard(req, reply)) return reply;
      const body = pairStartSchema.parse(req.body ?? {});
      return pairing.start({
        name: body.name,
        platform: body.platform,
        ip: req.ip,
        previousAgentId: body.previousAgentId ?? null,
      });
    },
  );

  app.post(
    "/api/agent/pair/poll",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!agentTlsGuard(req, reply)) return reply;
      const body = pairPollSchema.parse(req.body ?? {});
      return pairing.poll(body.deviceCode);
    },
  );

  // ----------------------------------------------- pairing (website side)

  app.register(async (authed) => {
    authed.addHook("preHandler", auth.authenticate);

    /** Device details for the approval page. 404 for unknown/expired codes. */
    authed.get("/api/agent/pair/:code", async (req, reply) => {
      const { code } = userCodeSchema.parse(req.params);
      const info = pairing.info(code, req.ip);
      if (!info) return reply.code(404).send({ error: "unknown or expired code" });

      // When approving will reuse an existing agent, tell the approval page
      // which one ("this replaces X" instead of silently rotating a token).
      let replacesAgent: { id: string; name: string } | null = null;
      if (info.previousAgentId) {
        const rows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(
            and(
              eq(agents.id, info.previousAgentId),
              eq(agents.userId, req.user!.id),
              isNull(agents.revokedAt),
            ),
          );
        replacesAgent = rows[0] ?? null;
      }

      return {
        name: info.name,
        platform: info.platform,
        requestIp: info.ip,
        startedAt: info.createdAt.toISOString(),
        replacesAgent,
      };
    });

    /**
     * Re-pairing reuses the existing agent row (rotating the token, keeping
     * the id) so linked environments keep working. Match by previousAgentId
     * when the device remembers it, else by an offline agent with the same
     * name and platform.
     */
    const findReusableAgent = async (
      userId: number,
      info: { name: string; platform: string; previousAgentId: string | null },
    ) => {
      if (info.previousAgentId) {
        const rows = await db
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.id, info.previousAgentId),
              eq(agents.userId, userId),
              isNull(agents.revokedAt),
            ),
          );
        if (rows[0]) return rows[0];
      }
      const rows = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.userId, userId),
            eq(agents.name, info.name),
            eq(agents.platform, info.platform),
            isNull(agents.revokedAt),
          ),
        )
        .orderBy(agents.createdAt);
      return rows.find((r) => !hub.isOnline(r.id)) ?? null;
    };

    authed.post("/api/agent/pair/:code/approve", async (req, reply) => {
      const { code } = userCodeSchema.parse(req.params);
      const info = pairing.info(code, req.ip);
      if (!info) return reply.code(404).send({ error: "unknown or expired code" });

      const token = generateAgentToken();

      const reuse = await findReusableAgent(req.user!.id, info);
      if (reuse) {
        await db
          .update(agents)
          .set({ tokenHash: hashAgentToken(token), name: info.name, platform: info.platform })
          .where(eq(agents.id, reuse.id));
        if (!pairing.approve(code, req.ip, { token, agentId: reuse.id })) {
          // Raced with expiry/another approval: restore the old credential.
          await db
            .update(agents)
            .set({ tokenHash: reuse.tokenHash, name: reuse.name, platform: reuse.platform })
            .where(eq(agents.id, reuse.id));
          return reply.code(409).send({ error: "code is no longer approvable" });
        }
        return { ok: true, agentId: reuse.id, reused: true };
      }

      // Only genuinely new agents count toward the limit (re-pairing above
      // replaces, never adds).
      const existing = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.userId, req.user!.id), isNull(agents.revokedAt)));
      if (existing.length >= config.maxAgentsPerUser) {
        return reply.code(403).send({
          error:
            `agent limit reached (${config.maxAgentsPerUser}). ` +
            "Revoke an agent you no longer use in Account → My agents, then try again.",
        });
      }

      const [row] = await db
        .insert(agents)
        .values({
          userId: req.user!.id,
          name: info.name,
          platform: info.platform,
          tokenHash: hashAgentToken(token),
        })
        .returning({ id: agents.id });

      if (!pairing.approve(code, req.ip, { token, agentId: row.id })) {
        // Raced with expiry/another approval: don't leave an orphaned credential.
        await db.delete(agents).where(eq(agents.id, row.id));
        return reply.code(409).send({ error: "code is no longer approvable" });
      }
      return { ok: true, agentId: row.id, reused: false };
    });

    authed.post("/api/agent/pair/:code/deny", async (req, reply) => {
      const { code } = userCodeSchema.parse(req.params);
      if (!pairing.deny(code, req.ip)) {
        return reply.code(404).send({ error: "unknown or expired code" });
      }
      return { ok: true };
    });

    // ------------------------------------------------- agent management

    /** The caller's paired agents with live status and discovered sticks. */
    authed.get("/api/agents", async (req) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.userId, req.user!.id), isNull(agents.revokedAt)))
        .orderBy(agents.createdAt);

      const envRows = rows.length
        ? await db
            .select({
              id: environments.id,
              name: environments.name,
              agentId: environments.agentId,
              serial: environments.loggerSerial,
            })
            .from(environments)
            .where(
              and(
                inArray(environments.agentId, rows.map((a) => a.id)),
                isNull(environments.deletedAt),
              ),
            )
        : [];

      return rows.map((a) => ({
        id: a.id,
        name: a.name,
        platform: a.platform,
        version: a.version || null,
        online: hub.isOnline(a.id),
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
        sticks: hub.sticksFor(a.id),
        environments: envRows
          .filter((e) => e.agentId === a.id)
          .map((e) => ({ id: e.id, name: e.name, serial: e.serial })),
      }));
    });

    /** Load an agent owned by the caller, or 404. */
    const ownAgent = async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, req.user!.id), isNull(agents.revokedAt)));
      if (!rows[0]) {
        void reply.code(404).send({ error: "not found" });
        return null;
      }
      return rows[0];
    };

    authed.patch("/api/agents/:id", async (req, reply) => {
      const agent = await ownAgent(req, reply);
      if (!agent) return reply;
      const { name } = renameSchema.parse(req.body ?? {});
      await db.update(agents).set({ name }).where(eq(agents.id, agent.id));
      return { ok: true, name };
    });

    /** Revoke: the credential dies and the live connection is kicked. */
    authed.delete("/api/agents/:id", async (req, reply) => {
      const agent = await ownAgent(req, reply);
      if (!agent) return reply;
      await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agent.id));
      hub.disconnect(agent.id, "revoked");
      return { ok: true };
    });

    /**
     * Probe one stick through the agent: detect the inverter and take a live
     * sample. Read-only; used by the picker before linking an environment.
     */
    authed.post("/api/agents/:id/test", async (req, reply) => {
      const agent = await ownAgent(req, reply);
      if (!agent) return reply;
      const { serial } = testSchema.parse(req.body ?? {});
      const transport = hub.transportFor(agent.id, serial);
      if (!transport) {
        return reply.code(409).send({ error: "agent offline or stick not visible to it" });
      }
      try {
        const inverter = new DeyeInverter(transport, {});
        const detected = await inverter.detectConfig();
        const live = await inverter.readLive(detected);
        return {
          ok: true as const,
          config: detected,
          sample: { pvW: live.pvW, loadW: live.loadW, gridW: live.gridW, battW: live.battW, soc: live.soc },
        };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    });
  });
}
