import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { environments, memberships, users, type MembershipRole } from "../db/schema.js";
import type { EnvironmentRow } from "../runtime/environment.js";
import { AuthError, type TokenVerifier } from "./verifier.js";

/** The environment created by the multi-tenant migration for pre-existing data. */
export const LEGACY_ENV_ID = "00000000-0000-0000-0000-000000000001";

export interface SessionUser {
  id: number;
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

export interface EnvAccess {
  env: EnvironmentRow;
  role: MembershipRole;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
    envAccess?: EnvAccess;
  }
}

const ROLE_RANK: Record<MembershipRole, number> = { viewer: 0, installer: 1, owner: 2 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_CACHE_TTL_MS = 60000;

export interface AuthOptions {
  db: Db;
  verifier: TokenVerifier;
  /** AUTH_MODE=disabled: single-user instance, everything is owner. */
  disabled: boolean;
  /** Email granted ownership of the legacy environment on first login. */
  bootstrapOwnerEmail: string;
  /**
   * Environment id of the public demo (read-only guest access); empty = off.
   * A getter so tests can point it at an environment created at runtime.
   */
  demoEnvId?: () => string;
}

export interface AuthHooks {
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  authorizeEnv: (
    minRole: MembershipRole,
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Verify a raw token outside the HTTP hook flow (WebSocket auth). */
  resolveUser: (token: string) => Promise<SessionUser>;
  /** Role of a user on an environment; null when not a member. */
  roleFor: (userId: number, envId: string) => Promise<MembershipRole | null>;
  /**
   * Anonymous read-only access: viewer EnvAccess for the public demo
   * environment or for an environment whose share link token matches.
   * Used by HTTP and WS guest paths.
   */
  guestEnvAccess: (envId: string, shareToken?: string) => Promise<EnvAccess | null>;
  /** Resolve a share link token to its environment; null when unknown/disabled. */
  envByShareToken: (token: string) => Promise<EnvironmentRow | null>;
}

export function createAuth(opts: AuthOptions): AuthHooks {
  const { db, verifier, disabled } = opts;
  const userCache = new Map<string, { at: number; user: SessionUser }>();

  async function upsertUser(token: string): Promise<SessionUser> {
    const identity = await verifier.verify(token);
    const cached = userCache.get(identity.uid);
    if (cached && Date.now() - cached.at < USER_CACHE_TTL_MS) return cached.user;

    const [row] = await db
      .insert(users)
      .values({
        firebaseUid: identity.uid,
        email: identity.email,
        displayName: identity.displayName,
      })
      .onConflictDoUpdate({
        target: users.firebaseUid,
        set: { email: identity.email, displayName: identity.displayName },
      })
      .returning({ id: users.id });

    const user: SessionUser = {
      id: row.id,
      uid: identity.uid,
      email: identity.email,
      emailVerified: identity.emailVerified,
      displayName: identity.displayName,
    };

    // Bootstrap: the configured owner email claims the migrated legacy environment.
    if (opts.bootstrapOwnerEmail && identity.email === opts.bootstrapOwnerEmail) {
      const legacy = await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, LEGACY_ENV_ID), isNull(environments.deletedAt)));
      if (legacy.length > 0) {
        await db
          .insert(memberships)
          .values({ userId: user.id, environmentId: LEGACY_ENV_ID, role: "owner" })
          .onConflictDoNothing();
      }
    }

    userCache.set(identity.uid, { at: Date.now(), user });
    return user;
  }

  async function resolveUser(token: string): Promise<SessionUser> {
    return upsertUser(token);
  }

  /**
   * Viewer-level access without an account: the public demo environment, or
   * any environment when the request carries its active share link token.
   */
  async function guestEnvAccess(envId: string, shareToken?: string): Promise<EnvAccess | null> {
    if (!UUID_RE.test(envId)) return null;
    const demoEnvId = opts.demoEnvId?.() ?? "";
    const isDemo = !!demoEnvId && envId === demoEnvId;
    if (!isDemo && !shareToken) return null;
    const rows = await db
      .select()
      .from(environments)
      .where(and(eq(environments.id, envId), isNull(environments.deletedAt)));
    const env = rows[0];
    if (!env) return null;
    if (!isDemo && (!env.shareToken || env.shareToken !== shareToken)) return null;
    return { env, role: "viewer" };
  }

  async function envByShareToken(token: string): Promise<EnvironmentRow | null> {
    if (!token || token.length < 16) return null;
    const rows = await db
      .select()
      .from(environments)
      .where(and(eq(environments.shareToken, token), isNull(environments.deletedAt)));
    return rows[0] ?? null;
  }

  async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token && !disabled) {
      // Anonymous guest: no token, but the request targets the public demo
      // environment or carries a valid share link token for the target env.
      // req.user stays unset; authorizeEnv picks this up.
      const { envId } = req.params as { envId?: string };
      if (envId) {
        const shareHeader = req.headers["x-share-token"];
        const shareToken = typeof shareHeader === "string" ? shareHeader : undefined;
        const guest = await guestEnvAccess(envId, shareToken);
        if (guest) {
          req.envAccess = guest;
          return;
        }
      }
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      req.user = await upsertUser(token);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      throw err;
    }
  }

  async function roleFor(userId: number, envId: string): Promise<MembershipRole | null> {
    if (disabled) return "owner";
    const rows = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.environmentId, envId)));
    return rows[0]?.role ?? null;
  }

  function authorizeEnv(minRole: MembershipRole) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const { envId } = req.params as { envId?: string };
      if (!req.user) {
        // Demo guest (set by authenticate): read-only viewer on that env only.
        if (
          req.envAccess &&
          req.envAccess.env.id === envId &&
          ROLE_RANK[req.envAccess.role] >= ROLE_RANK[minRole]
        ) {
          return;
        }
        return reply
          .code(req.envAccess ? 403 : 401)
          .send({ error: req.envAccess ? "forbidden" : "unauthorized" });
      }
      if (!envId || !UUID_RE.test(envId)) {
        return reply.code(404).send({ error: "not found" });
      }
      const envRows = await db
        .select()
        .from(environments)
        .where(and(eq(environments.id, envId), isNull(environments.deletedAt)));
      const env = envRows[0];
      // Non-members get the same 404 as a missing environment.
      if (!env) return reply.code(404).send({ error: "not found" });
      const role = await roleFor(req.user.id, envId);
      if (!role) return reply.code(404).send({ error: "not found" });
      if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
        return reply.code(403).send({ error: "forbidden" });
      }
      req.envAccess = { env, role };
    };
  }

  return { authenticate, authorizeEnv, resolveUser, roleFor, guestEnvAccess, envByShareToken };
}
