import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import type { Db } from "./db/client.js";
import { createAuth, type AuthHooks } from "./auth/plugin.js";
import {
  DisabledAuthVerifier,
  EmulatorVerifier,
  FirebaseVerifier,
  type TokenVerifier,
} from "./auth/verifier.js";
import { LoggerGateway } from "./gateway/server.js";
import { AgentHub } from "./agent/hub.js";
import { PairingStore } from "./agent/pairing.js";
import { RuntimeManager } from "./runtime/manager.js";
import type { PollerOptions } from "./services/poller.js";
import { registerRoutes } from "./api/routes.js";
import { registerWebsocket } from "./api/ws.js";

export interface BuildServerOptions {
  db: Db;
  /** Override the token verifier (tests). Defaults to config-driven choice. */
  verifier?: TokenVerifier;
  /** Create the TCP logger gateway (listen() is the caller's job). */
  withGateway?: boolean;
  pollOpts?: PollerOptions;
  logLevel?: string;
}

export interface BuiltServer {
  app: FastifyInstance;
  manager: RuntimeManager;
  gateway: LoggerGateway | null;
  hub: AgentHub;
  auth: AuthHooks;
}

export function pickVerifier(): TokenVerifier {
  if (config.authMode === "disabled") {
    console.warn(
      "AUTH_MODE=disabled — every request is treated as one local owner. " +
        "Never expose this instance to the internet.",
    );
    return new DisabledAuthVerifier();
  }
  if (!config.firebaseProjectId) {
    throw new Error(
      "FIREBASE_PROJECT_ID is required (or set AUTH_MODE=disabled for a private single-user instance)",
    );
  }
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.NODE_ENV !== "production") {
    console.warn(`Using the Firebase Auth emulator at ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
    return new EmulatorVerifier(config.firebaseProjectId);
  }
  return new FirebaseVerifier(config.firebaseProjectId);
}

export async function buildServer(opts: BuildServerOptions): Promise<BuiltServer> {
  const app = Fastify({
    logger: { level: opts.logLevel ?? process.env.LOG_LEVEL ?? "info" },
    trustProxy: true,
  });

  // Zod parse failures in handlers are client errors, not server crashes.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    req.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    return reply
      .code(status)
      .send({ error: status >= 500 ? "internal error" : (e.message ?? "error") });
  });

  // Same-origin deployments (nginx proxy) need no CORS; cross-origin SPAs
  // must be allowlisted explicitly.
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
  });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: "1 minute",
  });

  const verifier = opts.verifier ?? pickVerifier();
  const auth = createAuth({
    db: opts.db,
    verifier,
    disabled: config.authMode === "disabled" && !opts.verifier,
    bootstrapOwnerEmail: config.bootstrapOwnerEmail,
  });

  const pollOpts = opts.pollOpts ?? {
    pollIntervalMs: config.pollIntervalMs,
    fullPollIntervalMs: config.fullPollIntervalMs,
  };
  const manager = new RuntimeManager(opts.db, app.log, pollOpts);

  const gateway =
    opts.withGateway === false
      ? null
      : new LoggerGateway(manager, app.log, {
          port: config.loggerPort,
          tlsCertFile: config.gatewayTlsCertFile || undefined,
          tlsKeyFile: config.gatewayTlsKeyFile || undefined,
        });

  const hub = new AgentHub(opts.db, manager, app.log);
  const pairing = new PairingStore();

  const deps = { db: opts.db, manager, gateway, hub, pairing, auth };
  await registerWebsocket(app, deps);
  registerRoutes(app, deps);

  return { app, manager, gateway, hub, auth };
}
