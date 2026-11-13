/**
 * Anonymous guest access: the public demo environment (DEMO_ENV_ID) and
 * share links (x-share-token / WS share field). Real Fastify app + real
 * Postgres test database, StaticVerifier standing in for Firebase.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket from "ws";

import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { StaticVerifier, type AuthUser } from "../src/auth/verifier.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { config } from "../src/config.js";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_guest";

const USERS: Record<string, AuthUser> = {
  "token-alice": { uid: "uid-alice", email: "alice@test.dev", emailVerified: true, displayName: "Alice" },
  "token-bob": { uid: "uid-bob", email: "bob@test.dev", emailVerified: true, displayName: "Bob" },
};

let server: BuiltServer;
let db: Db;
let pool: pg.Pool;
let demoEnvId: string;
let privateEnvId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);
  const created = createDb(testUrl);
  db = created.db;
  pool = created.pool;
  await runMigrations(db, 1);

  server = await buildServer({
    db,
    verifier: new StaticVerifier(new Map(Object.entries(USERS))),
    withGateway: false,
    pollOpts: { pollIntervalMs: 1000, fullPollIntervalMs: 10000 },
    logLevel: "silent",
  });
  await server.app.ready();

  // Alice owns both environments; the first becomes the public demo.
  for (const name of ["Demo env", "Private env"]) {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-alice"),
      payload: { name, timezone: "Europe/Lisbon", lat: 38.72, lon: -9.14, sourceType: "simulator" },
    });
    expect(res.statusCode).toBe(201);
    if (name === "Demo env") demoEnvId = res.json().id;
    else privateEnvId = res.json().id;
  }
  config.demoEnvId = demoEnvId;
}, 60000);

afterAll(async () => {
  config.demoEnvId = "";
  await server?.manager.shutdown();
  await server?.app.close();
  await pool?.end();
});

/** One guest WS round-trip: resolves with the close code (0 = got ready). */
function wsAttempt(port: number, envId: string, share?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/live?env=${envId}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("ws timeout"));
    }, 5000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: "", share })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ready") {
        clearTimeout(timer);
        ws.close();
        resolve(0);
      }
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on("error", () => { /* close follows */ });
  });
}

describe("demo environment guest access", () => {
  it("lets anonymous requests read the demo environment", async () => {
    const res = await server.app.inject({ url: `/api/environments/${demoEnvId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: demoEnvId, role: "viewer" });

    const live = await server.app.inject({ url: `/api/environments/${demoEnvId}/live` });
    expect(live.statusCode).toBe(200);
  });

  it("blocks anonymous writes on the demo environment", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${demoEnvId}`,
      payload: { name: "hacked" },
    });
    expect(res.statusCode).toBe(403);

    const layout = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${demoEnvId}/layout`,
      payload: { circles: [] },
    });
    expect(layout.statusCode).toBe(403);
  });

  it("hides member emails and personal layout from guests", async () => {
    const members = await server.app.inject({ url: `/api/environments/${demoEnvId}/members` });
    expect(members.statusCode).toBe(200);
    expect(members.json()).toEqual([]);

    const layout = await server.app.inject({ url: `/api/environments/${demoEnvId}/layout` });
    expect(layout.statusCode).toBe(404);
  });

  it("keeps every other environment private", async () => {
    const res = await server.app.inject({ url: `/api/environments/${privateEnvId}` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for everything when no demo is configured", async () => {
    const saved = config.demoEnvId;
    config.demoEnvId = "";
    try {
      const res = await server.app.inject({ url: `/api/environments/${demoEnvId}` });
      expect(res.statusCode).toBe(401);
    } finally {
      config.demoEnvId = saved;
    }
  });

  it("exposes demoEnvId in the public config", async () => {
    const res = await server.app.inject({ url: "/api/system/config" });
    expect(res.json().demoEnvId).toBe(demoEnvId);
  });

  it("streams live data to anonymous sockets on the demo env only", async () => {
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (server.app.server.address() as AddressInfo).port;

    expect(await wsAttempt(port, demoEnvId)).toBe(0); // ready received
    expect(await wsAttempt(port, privateEnvId)).toBe(4401);
  });
});

describe("share links", () => {
  let shareToken: string;

  it("lets the owner create a share link", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/environments/${privateEnvId}/share`,
      headers: auth("token-alice"),
    });
    expect(res.statusCode).toBe(200);
    shareToken = res.json().shareToken;
    expect(shareToken.length).toBeGreaterThanOrEqual(16);

    const read = await server.app.inject({
      url: `/api/environments/${privateEnvId}/share`,
      headers: auth("token-alice"),
    });
    expect(read.json().shareToken).toBe(shareToken);
  });

  it("keeps share management owner-only", async () => {
    const anon = await server.app.inject({
      method: "POST",
      url: `/api/environments/${privateEnvId}/share`,
    });
    expect(anon.statusCode).toBe(401);

    // Bob is not a member: same 404 as a missing environment.
    const bob = await server.app.inject({
      method: "POST",
      url: `/api/environments/${privateEnvId}/share`,
      headers: auth("token-bob"),
    });
    expect(bob.statusCode).toBe(404);
  });

  it("resolves the token via /api/shared/:token", async () => {
    const res = await server.app.inject({ url: `/api/shared/${shareToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ envId: privateEnvId, name: "Private env" });

    const unknown = await server.app.inject({ url: "/api/shared/not-a-real-token-123" });
    expect(unknown.statusCode).toBe(404);
  });

  it("grants anonymous read access with the x-share-token header", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${privateEnvId}`,
      headers: { "x-share-token": shareToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: privateEnvId, role: "viewer" });

    const wrong = await server.app.inject({
      url: `/api/environments/${privateEnvId}`,
      headers: { "x-share-token": "wrong-token-wrong-token" },
    });
    expect(wrong.statusCode).toBe(401);

    // The token only opens its own environment.
    const other = await server.app.inject({
      url: `/api/environments/${demoEnvId}/members`,
      headers: { "x-share-token": shareToken },
    });
    expect(other.json()).toEqual([]); // demo guest path, not the share token
  });

  it("blocks writes through a share token", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${privateEnvId}`,
      headers: { "x-share-token": shareToken },
      payload: { name: "hacked" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("authenticates guest sockets with the share field", async () => {
    const port = (server.app.server.address() as AddressInfo).port;
    expect(await wsAttempt(port, privateEnvId, shareToken)).toBe(0);
    expect(await wsAttempt(port, privateEnvId, "wrong-token-wrong-token")).toBe(4401);
  });

  it("invalidates the old link on regenerate", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/environments/${privateEnvId}/share`,
      headers: auth("token-alice"),
    });
    const fresh = res.json().shareToken;
    expect(fresh).not.toBe(shareToken);

    const stale = await server.app.inject({
      url: `/api/environments/${privateEnvId}`,
      headers: { "x-share-token": shareToken },
    });
    expect(stale.statusCode).toBe(401);
    shareToken = fresh;
  });

  it("cuts access when sharing is disabled", async () => {
    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${privateEnvId}/share`,
      headers: auth("token-alice"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shareToken).toBeNull();

    const anon = await server.app.inject({
      url: `/api/environments/${privateEnvId}`,
      headers: { "x-share-token": shareToken },
    });
    expect(anon.statusCode).toBe(401);

    const resolve = await server.app.inject({ url: `/api/shared/${shareToken}` });
    expect(resolve.statusCode).toBe(404);
  });
});
