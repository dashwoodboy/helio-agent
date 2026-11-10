import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { config } from "../config.js";
import type { ApiDeps } from "./routes.js";
import type { AlertEvent, LiveSnapshot } from "../services/liveState.js";

const AUTH_TIMEOUT_MS = 5000;
/** Firebase ID tokens live ~1h; force a reconnect before that so the client re-authenticates. */
const SESSION_MAX_MS = 55 * 60000;

/** Close code sent when the environment's runtime is rebuilt; clients simply reconnect. */
export const WS_RECONFIGURED = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live stream: `/ws/live?env=<environmentId>`. The client must send
 * `{"type":"auth","token":"<firebase id token>"}` as its first message;
 * the socket closes with 4401 (unauthorized) or 4404 (unknown environment)
 * otherwise, and with 4401 when the session outlives the token.
 */
export async function registerWebsocket(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  // Agent frames are small (JSON RPC results, ≤125 registers); cap payloads defensively.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  /**
   * Helio Agent uplink. Authentication (Authorization: Bearer <agent token>)
   * and the protocol live in AgentHub; production deployments must terminate
   * TLS in front of this (enforced via AGENT_REQUIRE_TLS).
   */
  app.get("/ws/agent", { websocket: true }, (socket, req) => {
    if (config.agentRequireTls && req.protocol !== "https") {
      socket.close(4426, "TLS required");
      return;
    }
    void deps.hub.handleSocket(socket, req.headers).catch((err) => {
      req.log.error(err, "agent socket setup failed");
      socket.terminate();
    });
  });

  app.get("/ws/live", { websocket: true }, (socket, req) => {
    const envId = String((req.query as Record<string, unknown>).env ?? "");
    let authed = false;
    let cleanup: (() => void) | null = null;

    const authTimer = setTimeout(() => {
      if (!authed) socket.close(4401, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    const start = async (token: string): Promise<void> => {
      if (!UUID_RE.test(envId)) {
        socket.close(4404, "unknown environment");
        return;
      }
      let user;
      try {
        user = await deps.auth.resolveUser(token);
      } catch {
        socket.close(4401, "unauthorized");
        return;
      }
      const role = await deps.auth.roleFor(user.id, envId);
      if (!role) {
        socket.close(4404, "unknown environment");
        return;
      }
      const rt = await deps.manager.get(envId);
      if (!rt) {
        socket.close(4404, "unknown environment");
        return;
      }

      authed = true;
      clearTimeout(authTimer);
      rt.addViewer();

      const sendJson = (payload: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
      };

      sendJson({ type: "ready" });
      if (rt.liveState.current) {
        sendJson({ type: "live", data: { ...rt.liveState.current, outage: rt.outageTracker.status } });
      }

      const onLive = (snap: LiveSnapshot) =>
        sendJson({ type: "live", data: { ...snap, outage: rt.outageTracker.status } });
      const onAlert = (alert: AlertEvent) => sendJson({ type: "alert", data: alert });

      rt.liveState.on("live", onLive);
      rt.liveState.on("alert", onAlert);

      const ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, 30000);
      const expiry = setTimeout(() => socket.close(4401, "token expired"), SESSION_MAX_MS);
      // The environment was reconfigured (data source, location, claimed stick…) and this
      // runtime is gone: close so the client reconnects to the new one.
      const offDestroy = rt.onDestroy(() => socket.close(WS_RECONFIGURED, "environment reconfigured"));

      cleanup = () => {
        clearInterval(ping);
        clearTimeout(expiry);
        offDestroy();
        rt.liveState.off("live", onLive);
        rt.liveState.off("alert", onAlert);
        rt.removeViewer();
      };
    };

    socket.on("message", (raw: Buffer) => {
      if (authed) return; // only the auth message is accepted from clients
      let msg: { type?: string; token?: string } = {};
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.close(4401, "bad auth message");
        return;
      }
      if (msg.type !== "auth" || typeof msg.token !== "string") {
        socket.close(4401, "bad auth message");
        return;
      }
      void start(msg.token).catch(() => socket.close(1011, "internal error"));
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      cleanup?.();
      cleanup = null;
    });
  });
}
