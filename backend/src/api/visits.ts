/**
 * Page-visit beacon for the admin report. Public (the landing page has no
 * token) but soft-authed: a signed-in visitor gets their user id attached.
 * The client sends at most one beacon per session per kind, so volume stays
 * tiny; rows older than ~180 days are pruned opportunistically.
 */
import type { FastifyInstance } from "fastify";
import { lt } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { visits } from "../db/schema.js";
import type { AuthHooks } from "../auth/plugin.js";

const visitSchema = z.object({
  kind: z.enum(["landing", "app"]),
  sessionId: z.string().trim().min(8).max(64),
  envId: z.string().uuid().optional(),
});

export const VISIT_RETENTION_DAYS = 180;
const PRUNE_INTERVAL_MS = 6 * 3600000;

export interface VisitDeps {
  db: Db;
  auth: AuthHooks;
}

export function registerVisitRoutes(app: FastifyInstance, deps: VisitDeps): void {
  const { db, auth } = deps;
  let lastPrune = 0;

  app.post("/api/visits", async (req, reply) => {
    const body = visitSchema.parse(req.body ?? {});

    // Soft auth: attach the account when a valid token happens to be present.
    let userId: number | null = null;
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) {
      try {
        userId = (await auth.resolveUser(header.slice(7))).id;
      } catch {
        // Expired/invalid token: record as anonymous rather than rejecting.
      }
    }

    await db.insert(visits).values({
      sessionId: body.sessionId,
      kind: body.kind,
      environmentId: body.envId ?? null,
      userId,
      ip: req.ip ?? "",
    });

    const now = Date.now();
    if (now - lastPrune > PRUNE_INTERVAL_MS) {
      lastPrune = now;
      const cutoff = new Date(now - VISIT_RETENTION_DAYS * 86400000);
      void db
        .delete(visits)
        .where(lt(visits.ts, cutoff))
        .catch((err) => req.log.warn(err, "visit prune failed"));
    }

    return reply.code(201).send({ ok: true });
  });
}
