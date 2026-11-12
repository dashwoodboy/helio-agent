/**
 * Multi-tenant API tests: a real Fastify app (buildServer) wired to a real
 * Postgres test database, with a StaticVerifier standing in for Firebase.
 *
 * Requires a Postgres reachable at TEST_DATABASE_ADMIN_URL (defaults to
 * the dev container on :55432). The test database is recreated each run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket from "ws";

import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dailyEnergy, memberships, telemetry, visits } from "../src/db/schema.js";
import { StaticVerifier, type AuthUser } from "../src/auth/verifier.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { WS_RECONFIGURED } from "../src/api/ws.js";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_api";

const USERS: Record<string, AuthUser> = {
  "token-alice": { uid: "uid-alice", email: "alice@test.dev", emailVerified: true, displayName: "Alice" },
  "token-bob": { uid: "uid-bob", email: "bob@test.dev", emailVerified: true, displayName: "Bob" },
  "token-carol": { uid: "uid-carol", email: "carol@test.dev", emailVerified: false, displayName: "Carol" },
  "token-dave": { uid: "uid-dave", email: "dave@test.dev", emailVerified: true, displayName: "Dave" },
  "token-erin": { uid: "uid-erin", email: "erin@test.dev", emailVerified: true, displayName: "Erin" },
  "token-frank": { uid: "uid-frank", email: "frank@test.dev", emailVerified: true, displayName: "Frank" },
};

let server: BuiltServer;
let db: Db;
let pool: pg.Pool;

/** Captured feedback emails (the test server's mail sender records here). */
const sentMail: { to: string; subject: string; text: string; replyTo?: string }[] = [];
let failNextMail = false;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createEnv(
  token: string,
  overrides: Partial<{ name: string; sourceType: "gateway" | "simulator" }> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/environments",
    headers: auth(token),
    payload: {
      name: overrides.name ?? "Test env",
      timezone: "Europe/Lisbon",
      lat: 38.72,
      lon: -9.14,
      sourceType: overrides.sourceType ?? "simulator",
    },
  });
  return { status: res.statusCode, body: res.json() };
}

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
    sendMail: async (msg) => {
      if (failNextMail) {
        failNextMail = false;
        throw new Error("smtp down");
      }
      sentMail.push(msg);
    },
    adminEmails: ["alice@test.dev"],
    // Offline stand-in for ip-api.com: every public IP "is" in Lisbon.
    geoLookup: async (ips) =>
      ips.map((ip) => ({
        query: ip,
        status: "success" as const,
        lat: 38.72,
        lon: -9.14,
        city: "Lisbon",
        country: "Portugal",
      })),
  });
  await server.app.ready();
}, 60000);

afterAll(async () => {
  await server?.manager.shutdown();
  await server?.app.close();
  await pool?.end();
});

describe("authentication", () => {
  it("public endpoints work without a token", async () => {
    const health = await server.app.inject({ url: "/api/system/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);

    const cfg = await server.app.inject({ url: "/api/system/config" });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ authMode: "firebase" });
  });

  it("rejects requests without a token", async () => {
    const res = await server.app.inject({ url: "/api/environments" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown token", async () => {
    const res = await server.app.inject({
      url: "/api/environments",
      headers: auth("token-forged"),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("environment lifecycle", () => {
  let envId: string;

  it("unverified accounts can create environments too", async () => {
    const { status, body } = await createEnv("token-carol", { name: "Carol home" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "Carol home", role: "owner" });
  });

  it("creates an environment and lists it", async () => {
    const { status, body } = await createEnv("token-alice", { name: "Alice home" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "Alice home", role: "owner", sourceType: "simulator" });
    envId = body.id as string;

    const list = await server.app.inject({ url: "/api/environments", headers: auth("token-alice") });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((e: { id: string }) => e.id)).toContain(envId);
  });

  it("validates the payload (bad timezone)", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-alice"),
      payload: { name: "x", timezone: "Mars/Olympus", lat: 0, lon: 0 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("hides the environment from non-members (404, not 403)", async () => {
    for (const url of [
      `/api/environments/${envId}`,
      `/api/environments/${envId}/settings`,
      `/api/environments/${envId}/live`,
    ]) {
      const res = await server.app.inject({ url, headers: auth("token-bob") });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("404s on malformed and unknown environment ids", async () => {
    const bad = await server.app.inject({
      url: "/api/environments/not-a-uuid/settings",
      headers: auth("token-alice"),
    });
    expect(bad.statusCode).toBe(404);

    const unknown = await server.app.inject({
      url: "/api/environments/00000000-0000-0000-0000-00000000dead/settings",
      headers: auth("token-alice"),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("serves data routes to members", async () => {
    const cfg = await server.app.inject({
      url: `/api/environments/${envId}/config`,
      headers: auth("token-alice"),
    });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ simulate: true, sourceType: "simulator" });

    const day = await server.app.inject({
      url: `/api/environments/${envId}/history/day`,
      headers: auth("token-alice"),
    });
    expect(day.statusCode).toBe(200);

    const settings = await server.app.inject({
      url: `/api/environments/${envId}/settings`,
      headers: auth("token-alice"),
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toHaveProperty("tariffMode");
  });

  it("lets viewers read but not write", async () => {
    // Bob becomes a viewer directly in the database (invites come later).
    const bobList = await server.app.inject({ url: "/api/environments", headers: auth("token-bob") });
    expect(bobList.statusCode).toBe(200); // ensures bob's user row exists
    const [{ id: bobId }] = (
      await pool.query(`SELECT id FROM users WHERE firebase_uid = 'uid-bob'`)
    ).rows;
    await db.insert(memberships).values({ userId: bobId, environmentId: envId, role: "viewer" });

    const read = await server.app.inject({
      url: `/api/environments/${envId}/settings`,
      headers: auth("token-bob"),
    });
    expect(read.statusCode).toBe(200);

    const write = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/settings`,
      headers: auth("token-bob"),
      payload: { pvKwp: 9.9 },
    });
    expect(write.statusCode).toBe(403);

    const alertsRead = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/alerts/read`,
      headers: auth("token-bob"),
      payload: { ids: "all" },
    });
    expect(alertsRead.statusCode).toBe(403);

    const patch = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${envId}`,
      headers: auth("token-bob"),
      payload: { name: "hacked" },
    });
    expect(patch.statusCode).toBe(403);

    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${envId}`,
      headers: auth("token-bob"),
    });
    expect(del.statusCode).toBe(403);
  });

  it("owners can update settings and rename", async () => {
    // A fresh environment has never saved settings: the config flags it so the
    // frontend can show the first-run setup guide.
    const before = await server.app.inject({
      url: `/api/environments/${envId}/config`,
      headers: auth("token-alice"),
    });
    expect(before.json().settingsSaved).toBe(false);

    const write = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/settings`,
      headers: auth("token-alice"),
      payload: { pvKwp: 7.5 },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json().pvKwp).toBe(7.5);

    const after = await server.app.inject({
      url: `/api/environments/${envId}/config`,
      headers: auth("token-alice"),
    });
    expect(after.json().settingsSaved).toBe(true);

    const patch = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${envId}`,
      headers: auth("token-alice"),
      payload: { name: "Alice casa" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().name).toBe("Alice casa");
  });
});

describe("logger claim", () => {
  it("claims a serial and rejects double claims with 409", async () => {
    const a = await createEnv("token-alice", { name: "Alice gw", sourceType: "gateway" });
    expect(a.status).toBe(201);
    const b = await createEnv("token-bob", { name: "Bob gw", sourceType: "gateway" });
    expect(b.status).toBe(201);

    const claim = await server.app.inject({
      method: "POST",
      url: `/api/environments/${a.body.id}/logger/claim`,
      headers: auth("token-alice"),
      payload: { serial: 2712345678 },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ serial: 2712345678, connected: false });

    const steal = await server.app.inject({
      method: "POST",
      url: `/api/environments/${b.body.id}/logger/claim`,
      headers: auth("token-bob"),
      payload: { serial: 2712345678 },
    });
    expect(steal.statusCode).toBe(409);

    const status = await server.app.inject({
      url: `/api/environments/${a.body.id}/logger`,
      headers: auth("token-alice"),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ serial: 2712345678, connected: false });
  });
});

describe("environment quota", () => {
  it("limits owned environments to MAX_ENVIRONMENTS_PER_USER", async () => {
    // Alice owns 2 (home + gateway). Default quota is 3: one more fits.
    const third = await createEnv("token-alice", { name: "Third" });
    expect(third.status).toBe(201);
    const fourth = await createEnv("token-alice", { name: "Fourth" });
    expect(fourth.status).toBe(403);
    expect(String(fourth.body.error)).toContain("limit");
  });
});

describe("delete", () => {
  it("soft-deletes and hides the environment", async () => {
    const { status, body } = await createEnv("token-bob", { name: "Bob temp" });
    expect(status).toBe(201);
    const id = body.id as string;

    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${id}`,
      headers: auth("token-bob"),
    });
    expect(del.statusCode).toBe(200);

    const after = await server.app.inject({
      url: `/api/environments/${id}`,
      headers: auth("token-bob"),
    });
    expect(after.statusCode).toBe(404);

    const list = await server.app.inject({ url: "/api/environments", headers: auth("token-bob") });
    expect(list.json().map((e: { id: string }) => e.id)).not.toContain(id);
  });
});

describe("3-phase demo environments", () => {
  let envId3p: string;

  it("creating a simulator env with phases: 3 pins a 3-phase config", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-frank"),
      payload: {
        name: "Frank 3-phase demo",
        timezone: "Europe/Lisbon",
        lat: 38.72,
        lon: -9.14,
        sourceType: "simulator",
        phases: 3,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sourceType: "simulator", phases: 3 });
    envId3p = res.json().id as string;
  });

  it("the runtime reports a 3-phase config (via the real register reader)", async () => {
    const cfg = await server.app.inject({
      url: `/api/environments/${envId3p}/config`,
      headers: auth("token-frank"),
    });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({
      phases: 3,
      hasBattery: true,
      pvStrings: 2,
      hasGenerator: false,
      simulate: true,
    });
  });

  it("live snapshots carry per-phase loads and voltages", async () => {
    const snap = await vi.waitFor(
      async () => {
        const res = await server.app.inject({
          url: `/api/environments/${envId3p}/live`,
          headers: auth("token-frank"),
        });
        expect(res.statusCode).toBe(200);
        return res.json() as Record<string, number | null>;
      },
      { timeout: 15000, interval: 250 },
    );
    expect(snap.l1W).not.toBeNull();
    expect(snap.l2W).not.toBeNull();
    expect(snap.l3W).not.toBeNull();
    expect((snap.l1W ?? 0) + (snap.l2W ?? 0) + (snap.l3W ?? 0)).toBe(snap.loadW);
    expect(snap.l1V).not.toBeNull();
    expect(snap.l2V).not.toBeNull();
    expect(snap.l3V).not.toBeNull();
  });

  it("single-phase simulator environments are unchanged (no phases pinned)", async () => {
    const { status, body } = await createEnv("token-frank", { name: "Frank 1-phase" });
    expect(status).toBe(201);
    expect(body.phases).toBeNull();

    const cfg = await server.app.inject({
      url: `/api/environments/${body.id}/config`,
      headers: auth("token-frank"),
    });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ phases: 1, simulate: true });
  });

  it("ignores phases on non-simulator environments", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-frank"),
      payload: {
        name: "Bad",
        timezone: "Europe/Lisbon",
        lat: 38.72,
        lon: -9.14,
        sourceType: "gateway",
        phases: 3,
      },
    });
    // phases is simply ignored for non-simulator sources.
    expect(res.statusCode).toBe(201);
    expect(res.json().phases).toBeNull();
  });
});

describe("direct connection", () => {
  // TEST-NET address: never routed, so no real sockets are opened in CI.
  const IP = "203.0.113.10";
  const SERIAL = 3312345678;
  let directId: string;
  let simulatorId: string;

  const createDirect = (token: string, payload: Record<string, unknown>) =>
    server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth(token),
      payload: { name: "Direct", timezone: "Europe/Lisbon", lat: 38.7, lon: -9.1, sourceType: "direct", ...payload },
    });

  it("creates a direct environment with connection details", async () => {
    const res = await createDirect("token-bob", { inverterIp: IP, loggerSerial: SERIAL });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sourceType: "direct", loggerSerial: SERIAL, role: "owner" });
    directId = res.json().id;
  });

  it("rejects direct creation without ip or serial", async () => {
    const noIp = await createDirect("token-bob", { loggerSerial: 999999 });
    expect(noIp.statusCode).toBeGreaterThanOrEqual(400);
    expect(noIp.statusCode).toBeLessThan(500);

    const noSerial = await createDirect("token-bob", { inverterIp: IP });
    expect(noSerial.statusCode).toBeGreaterThanOrEqual(400);
    expect(noSerial.statusCode).toBeLessThan(500);
  });

  it("rejects a serial already linked to another environment (409)", async () => {
    const dup = await createDirect("token-bob", { inverterIp: IP, loggerSerial: SERIAL });
    expect(dup.statusCode).toBe(409);
  });

  it("exposes connection details to the owner only", async () => {
    const owner = await server.app.inject({
      url: `/api/environments/${directId}/connection`,
      headers: auth("token-bob"),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({ ip: IP, port: 8899, serial: SERIAL });

    // Alice becomes a viewer of the direct env.
    const [{ id: aliceId }] = (
      await pool.query(`SELECT id FROM users WHERE firebase_uid = 'uid-alice'`)
    ).rows;
    await db.insert(memberships).values({ userId: aliceId, environmentId: directId, role: "viewer" });

    const viewer = await server.app.inject({
      url: `/api/environments/${directId}/connection`,
      headers: auth("token-alice"),
    });
    expect(viewer.statusCode).toBe(403);
  });

  it("404s on non-direct environments", async () => {
    const sim = await createEnv("token-bob", { name: "Bob sim" });
    expect(sim.status).toBe(201);
    simulatorId = sim.body.id as string;

    const res = await server.app.inject({
      url: `/api/environments/${simulatorId}/connection`,
      headers: auth("token-bob"),
    });
    expect(res.statusCode).toBe(404);

    const put = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${simulatorId}/connection`,
      headers: auth("token-bob"),
      payload: { ip: IP, port: 8899, serial: 42 },
    });
    expect(put.statusCode).toBe(404);
  });

  it("owner can update the connection; viewers cannot", async () => {
    const put = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${directId}/connection`,
      headers: auth("token-bob"),
      payload: { ip: "203.0.113.11", port: 9000, serial: SERIAL + 1 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ip: "203.0.113.11", port: 9000, serial: SERIAL + 1 });

    const after = await server.app.inject({
      url: `/api/environments/${directId}/connection`,
      headers: auth("token-bob"),
    });
    expect(after.json()).toEqual({ ip: "203.0.113.11", port: 9000, serial: SERIAL + 1 });

    const viewerPut = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${directId}/connection`,
      headers: auth("token-alice"),
      payload: { ip: IP, port: 8899, serial: SERIAL },
    });
    expect(viewerPut.statusCode).toBe(403);
  });

  it("rejects updating to a serial claimed elsewhere (409)", async () => {
    const put = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${directId}/connection`,
      headers: auth("token-bob"),
      payload: { ip: IP, port: 8899, serial: 2712345678 }, // claimed in the logger tests
    });
    expect(put.statusCode).toBe(409);
  });

  it("test-connection reports unreachable sticks without writing state", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/environments/test-connection",
      headers: auth("token-bob"),
      payload: { ip: "127.0.0.1", port: 1, serial: 42 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(String(res.json().error)).toBeTruthy();

    const unverified = await server.app.inject({
      method: "POST",
      url: "/api/environments/test-connection",
      headers: auth("token-carol"),
      payload: { ip: "127.0.0.1", port: 1, serial: 42 },
    });
    expect(unverified.statusCode).toBe(200);
    expect(unverified.json().ok).toBe(false);

    const scopedTest = await server.app.inject({
      method: "POST",
      url: `/api/environments/${directId}/connection/test`,
      headers: auth("token-bob"),
      payload: { ip: "127.0.0.1", port: 1, serial: 42 },
    });
    expect(scopedTest.statusCode).toBe(200);
    expect(scopedTest.json().ok).toBe(false);
  });
});

describe("changing an environment's data source", () => {
  // TEST-NET addresses: never routed, so no real sockets are opened in CI.
  const IP = "203.0.113.20";
  const SERIAL = 3398765432;
  let gwId: string;
  let directId: string;
  let simId: string;

  const putSource = (token: string, id: string, payload: Record<string, unknown>) =>
    server.app.inject({
      method: "PUT",
      url: `/api/environments/${id}/source`,
      headers: auth(token),
      payload,
    });
  const connection = (token: string, id: string) =>
    server.app.inject({ url: `/api/environments/${id}/connection`, headers: auth(token) });

  beforeAll(async () => {
    const list = (await server.app.inject({ url: "/api/environments", headers: auth("token-bob") })).json() as {
      id: string; name: string; sourceType: string; role: string;
    }[];
    gwId = list.find((e) => e.name === "Bob gw" && e.role === "owner")!.id;
    directId = list.find((e) => e.name === "Direct" && e.role === "owner")!.id;
    simId = list.find((e) => e.name === "Bob sim" && e.role === "owner")!.id;
  });

  it("switches a logger-stick environment to a direct connection, keeping the environment", async () => {
    const res = await putSource("token-bob", gwId, { sourceType: "direct", ip: IP, port: 8899, serial: SERIAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: gwId, name: "Bob gw", sourceType: "direct", loggerSerial: SERIAL, role: "owner" });

    expect((await connection("token-bob", gwId)).json()).toEqual({ ip: IP, port: 8899, serial: SERIAL });
    // (Reading the summary rather than /config: /config would start polling the unrouted test address.)
    const summary = await server.app.inject({ url: `/api/environments/${gwId}`, headers: auth("token-bob") });
    expect(summary.json()).toMatchObject({ sourceType: "direct", loggerSerial: SERIAL });
  });

  it("defaults the port to 8899", async () => {
    const res = await putSource("token-bob", gwId, { sourceType: "direct", ip: IP, serial: SERIAL });
    expect(res.statusCode).toBe(200);
    expect((await connection("token-bob", gwId)).json()).toMatchObject({ port: 8899 });
  });

  it("validates the connection details", async () => {
    for (const payload of [
      { sourceType: "direct", serial: SERIAL }, // no ip
      { sourceType: "direct", ip: IP }, // no serial
      { sourceType: "direct", ip: IP, port: 70000, serial: SERIAL },
      { sourceType: "direct", ip: IP, port: 8899, serial: 0 },
      { sourceType: "satellite" },
      {},
    ]) {
      const res = await putSource("token-bob", gwId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, JSON.stringify(payload)).toBeLessThan(500);
    }
    // Nothing was changed by the rejected attempts.
    expect((await connection("token-bob", gwId)).json()).toMatchObject({ ip: IP, serial: SERIAL });
  });

  it("rejects a serial that belongs to another environment (409)", async () => {
    const other = (await connection("token-bob", directId)).json() as { serial: number };
    const res = await putSource("token-bob", gwId, { sourceType: "direct", ip: IP, port: 8899, serial: other.serial });
    expect(res.statusCode).toBe(409);
  });

  it("only owners can change the source", async () => {
    // Alice is a viewer of the direct environment (set up in the direct-connection tests).
    const viewer = await putSource("token-alice", directId, { sourceType: "gateway" });
    expect(viewer.statusCode).toBe(403);
    // Non-members don't even learn it exists.
    const stranger = await putSource("token-carol", gwId, { sourceType: "gateway" });
    expect(stranger.statusCode).toBe(404);
  });

  it("switches back to the logger stick, keeping the serial and dropping the LAN address", async () => {
    const res = await putSource("token-bob", gwId, { sourceType: "gateway" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: gwId, sourceType: "gateway", loggerSerial: SERIAL });
    expect((await connection("token-bob", gwId)).statusCode).toBe(404); // no longer a direct environment

    const logger = await server.app.inject({ url: `/api/environments/${gwId}/logger`, headers: auth("token-bob") });
    expect(logger.json()).toMatchObject({ serial: SERIAL, connected: false });
  });

  it("can go back and forth, history untouched", async () => {
    const toDirect = await putSource("token-bob", gwId, { sourceType: "direct", ip: IP, port: 9000, serial: SERIAL });
    expect(toDirect.json()).toMatchObject({ sourceType: "direct" });
    const toGateway = await putSource("token-bob", gwId, { sourceType: "gateway" });
    expect(toGateway.json()).toMatchObject({ sourceType: "gateway", loggerSerial: SERIAL });
    // Settings (and with them the tariff plans) live on the environment, not on the source.
    const settings = await server.app.inject({ url: `/api/environments/${gwId}/settings`, headers: auth("token-bob") });
    expect(settings.statusCode).toBe(200);
  });

  it("closes open live sockets so clients reconnect to the rebuilt runtime", async () => {
    // Without this, a dashboard that was open during the switch would stay bound to the
    // old runtime and quietly stop updating.
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/live?env=${gwId}`);
    const ready = new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type === "ready") resolve();
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: "token-bob" })));
    });
    await ready;

    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    const res = await putSource("token-bob", gwId, { sourceType: "direct", ip: IP, port: 8899, serial: SERIAL });
    expect(res.statusCode).toBe(200);
    expect(await closed).toBe(WS_RECONFIGURED);

    // leave the environment as the other tests expect it
    expect((await putSource("token-bob", gwId, { sourceType: "gateway" })).statusCode).toBe(200);
  });

  it("demo environments have no source to change", async () => {
    const res = await putSource("token-bob", simId, { sourceType: "direct", ip: IP, port: 8899, serial: 12345 });
    expect(res.statusCode).toBe(400);
  });
});

describe("members", () => {
  let envId: string;

  beforeAll(async () => {
    // Bob is at his environment quota; reuse the gateway env he owns.
    const list = await server.app.inject({ url: "/api/environments", headers: auth("token-bob") });
    envId = list
      .json()
      .find((e: { name: string; role: string }) => e.name === "Bob gw" && e.role === "owner").id;
  });

  const members = (token: string) =>
    server.app.inject({ url: `/api/environments/${envId}/members`, headers: auth(token) });
  const addMember = (token: string, payload: Record<string, unknown>) =>
    server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/members`,
      headers: auth(token),
      payload,
    });

  it("lists the owner with a me flag", async () => {
    const res = await members("token-bob");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ email: "bob@test.dev", role: "owner", me: true }),
    ]);
  });

  it("owner shares the environment with another account", async () => {
    const res = await addMember("token-bob", { email: "carol@test.dev", role: "viewer" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "carol@test.dev", role: "viewer", me: false });

    // Carol now sees the environment under her own login.
    const carolView = await server.app.inject({
      url: `/api/environments/${envId}`,
      headers: auth("token-carol"),
    });
    expect(carolView.statusCode).toBe(200);
    expect(carolView.json().role).toBe("viewer");
  });

  it("rejects duplicates, unknown emails, and non-owner invites", async () => {
    const dup = await addMember("token-bob", { email: "carol@test.dev" });
    expect(dup.statusCode).toBe(409);

    const unknown = await addMember("token-bob", { email: "nobody@test.dev" });
    expect(unknown.statusCode).toBe(404);

    const byViewer = await addMember("token-carol", { email: "alice@test.dev" });
    expect(byViewer.statusCode).toBe(403);
  });

  it("owner changes a member's role", async () => {
    const list = await members("token-bob");
    const carol = list.json().find((m: { email: string }) => m.email === "carol@test.dev");

    // As a viewer Carol cannot edit the environment…
    const denied = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${envId}`,
      headers: auth("token-carol"),
      payload: { name: "Carol was here" },
    });
    expect(denied.statusCode).toBe(403);

    const up = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${envId}/members/${carol.userId}`,
      headers: auth("token-bob"),
      payload: { role: "installer" },
    });
    expect(up.statusCode).toBe(200);

    // …as an installer she can.
    const allowed = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${envId}`,
      headers: auth("token-carol"),
      payload: { name: "Bob gw" },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("the owner cannot be demoted or removed", async () => {
    const list = await members("token-bob");
    const bob = list.json().find((m: { me: boolean }) => m.me);

    const demote = await server.app.inject({
      method: "PATCH",
      url: `/api/environments/${envId}/members/${bob.userId}`,
      headers: auth("token-bob"),
      payload: { role: "viewer" },
    });
    expect(demote.statusCode).toBe(400);

    const remove = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${envId}/members/${bob.userId}`,
      headers: auth("token-bob"),
    });
    expect(remove.statusCode).toBe(400);
  });

  it("a member can leave; a non-owner cannot remove others", async () => {
    const list = await members("token-bob");
    const bob = list.json().find((m: { me: boolean }) => m.me);

    const carolRemovesBob = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${envId}/members/${bob.userId}`,
      headers: auth("token-carol"),
    });
    expect(carolRemovesBob.statusCode).toBe(403);

    const carol = list.json().find((m: { email: string }) => m.email === "carol@test.dev");
    const leave = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${envId}/members/${carol.userId}`,
      headers: auth("token-carol"),
    });
    expect(leave.statusCode).toBe(200);

    const after = await server.app.inject({
      url: `/api/environments/${envId}`,
      headers: auth("token-carol"),
    });
    expect(after.statusCode).toBe(404);
  });

  it("email lookup is case-insensitive and owner can remove members", async () => {
    const readd = await addMember("token-bob", { email: "CAROL@test.dev", role: "viewer" });
    expect(readd.statusCode).toBe(201);

    const list = await members("token-bob");
    const carol = list.json().find((m: { email: string }) => m.email === "carol@test.dev");
    const kick = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${envId}/members/${carol.userId}`,
      headers: auth("token-bob"),
    });
    expect(kick.statusCode).toBe(200);

    const gone = await server.app.inject({
      url: `/api/environments/${envId}`,
      headers: auth("token-carol"),
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe("AC-coupling backfill", () => {
  const PAST_DAY = "2026-01-15"; // Europe/Lisbon is UTC+0 in January
  const EMPTY_DAY = "2026-01-16"; // daily row but no telemetry
  let envId: string;
  let today: string;

  beforeAll(async () => {
    const list = await server.app.inject({ url: "/api/environments", headers: auth("token-carol") });
    envId = list
      .json()
      .find((e: { name: string; role: string }) => e.name === "Carol home" && e.role === "owner").id;
    today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());

    // A past day whose telemetry shows 1.2 kW of battery charging that
    // neither solar nor grid-beyond-the-load explains: 60 one-minute rows
    // of 1200 W residual = 1.2 kWh of AC coupling.
    const dayStart = new Date(`${PAST_DAY}T10:00:00Z`).getTime();
    await db.insert(telemetry).values(
      Array.from({ length: 60 }, (_, i) => ({
        environmentId: envId,
        ts: new Date(dayStart + i * 60000),
        pvW: 0,
        loadW: 500,
        gridW: 500, // fully consumed by the load
        battW: 1200,
        genW: 0,
      })),
    );
    await db.insert(dailyEnergy).values([
      {
        environmentId: envId,
        date: PAST_DAY,
        pvToLoadKwh: 2.5,
        gridToBattKwh: 9.9, // deliberately wrong: the backfill must not touch it
        acPvToBattKwh: 0,
      },
      { environmentId: envId, date: EMPTY_DAY, acPvToBattKwh: 0 },
    ]);
  });

  it("requires membership and write access", async () => {
    const stranger = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/ac-coupling/backfill`,
      headers: auth("token-bob"),
    });
    expect(stranger.statusCode).toBe(404);
  });

  it("recomputes past days from telemetry and leaves other columns alone", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/ac-coupling/backfill`,
      headers: auth("token-carol"),
    });
    expect(res.statusCode).toBe(200);
    const { daysUpdated, daysSkipped } = res.json();
    expect(daysUpdated).toBe(1);
    expect(daysSkipped).toBeGreaterThanOrEqual(1); // the telemetry-less day

    const { rows } = await pool.query(
      `SELECT date::text, ac_pv_to_batt_kwh, pv_to_load_kwh, grid_to_batt_kwh
       FROM daily_energy WHERE environment_id = $1 ORDER BY date`,
      [envId],
    );
    const past = rows.find((r) => r.date === PAST_DAY);
    expect(past.ac_pv_to_batt_kwh).toBeCloseTo(1.2, 3);
    expect(past.pv_to_load_kwh).toBeCloseTo(2.5, 3);
    expect(past.grid_to_batt_kwh).toBeCloseTo(9.9, 3);

    const empty = rows.find((r) => r.date === EMPTY_DAY);
    expect(empty.ac_pv_to_batt_kwh).toBe(0);
  });

  it("skips today (the recorder owns it) and is idempotent", async () => {
    await db.insert(dailyEnergy).values({ environmentId: envId, date: today, acPvToBattKwh: 0.123 }).onConflictDoNothing();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/ac-coupling/backfill`,
      headers: auth("token-carol"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().daysUpdated).toBe(1); // same single day, same result

    const { rows } = await pool.query(
      `SELECT date::text, ac_pv_to_batt_kwh FROM daily_energy WHERE environment_id = $1`,
      [envId],
    );
    expect(rows.find((r) => r.date === PAST_DAY).ac_pv_to_batt_kwh).toBeCloseTo(1.2, 3);
  });
});

describe("web push", () => {
  const ENDPOINT = "https://push.example.com/sub/abc123";

  it("requires auth and serves a stable VAPID public key", async () => {
    const anon = await server.app.inject({ url: "/api/push/public-key" });
    expect(anon.statusCode).toBe(401);

    const first = await server.app.inject({ url: "/api/push/public-key", headers: auth("token-alice") });
    expect(first.statusCode).toBe(200);
    const key = first.json().publicKey;
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(20);

    const second = await server.app.inject({ url: "/api/push/public-key", headers: auth("token-bob") });
    expect(second.json().publicKey).toBe(key); // persisted, not regenerated
  });

  it("stores a subscription, re-keys it by endpoint, and unsubscribes", async () => {
    const subscribe = (token: string) =>
      server.app.inject({
        method: "POST",
        url: "/api/push/subscribe",
        headers: auth(token),
        payload: { endpoint: ENDPOINT, keys: { p256dh: "pkey", auth: "akey" } },
      });

    expect((await subscribe("token-alice")).statusCode).toBe(201);
    // The same browser endpoint switching accounts moves ownership.
    expect((await subscribe("token-bob")).statusCode).toBe(201);
    const { rows } = await pool.query("SELECT user_id FROM push_subscriptions WHERE endpoint = $1", [ENDPOINT]);
    expect(rows).toHaveLength(1);

    // Alice no longer owns it, so her unsubscribe is a no-op…
    await server.app.inject({
      method: "DELETE",
      url: "/api/push/subscribe",
      headers: auth("token-alice"),
      payload: { endpoint: ENDPOINT },
    });
    expect((await pool.query("SELECT 1 FROM push_subscriptions WHERE endpoint = $1", [ENDPOINT])).rows).toHaveLength(1);

    // …while Bob's removes it.
    await server.app.inject({
      method: "DELETE",
      url: "/api/push/subscribe",
      headers: auth("token-bob"),
      payload: { endpoint: ENDPOINT },
    });
    expect((await pool.query("SELECT 1 FROM push_subscriptions WHERE endpoint = $1", [ENDPOINT])).rows).toHaveLength(0);
  });

  it("rejects malformed subscriptions", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      headers: auth("token-alice"),
      payload: { endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe("dashboard layout", () => {
  let envId: string;

  beforeAll(async () => {
    const list = await server.app.inject({ url: "/api/environments", headers: auth("token-bob") });
    envId = list
      .json()
      .find((e: { name: string; role: string }) => e.name === "Bob gw" && e.role === "owner").id;
    // Share with Carol as a read-only viewer for the isolation tests
    // (the members suite above removed her again).
    await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/members`,
      headers: auth("token-bob"),
      payload: { email: "carol@test.dev", role: "viewer" },
    });
  });

  const getLayout = (token: string) =>
    server.app.inject({ url: `/api/environments/${envId}/layout`, headers: auth(token) });
  const putLayout = (token: string, payload: Record<string, unknown>) =>
    server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/layout`,
      headers: auth(token),
      payload,
    });

  it("404s before a layout is saved", async () => {
    const res = await getLayout("token-bob");
    expect(res.statusCode).toBe(404);
  });

  it("saves and returns a member's layout", async () => {
    const layout = {
      widgets: [
        { id: "live-flow", size: "lg" },
        { id: "live-battery", size: "sm" },
      ],
    };
    const put = await putLayout("token-bob", layout);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(layout);

    const get = await getLayout("token-bob");
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(layout);
  });

  it("each member has their own layout — even read-only ones", async () => {
    const carolLayout = { widgets: [{ id: "live-insights", size: "full" }] };
    const put = await putLayout("token-carol", carolLayout);
    expect(put.statusCode).toBe(200);

    expect((await getLayout("token-carol")).json()).toEqual(carolLayout);
    // Bob's layout is untouched.
    expect((await getLayout("token-bob")).json().widgets).toHaveLength(2);
  });

  it("round-trips the energy-flow circle config", async () => {
    const layout = {
      widgets: [{ id: "live-flow", size: "lg" }],
      flow: { battery: { main: "power", sub: "eta" }, grid: { main: "voltage" } },
    };
    const put = await putLayout("token-bob", layout);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(layout);
    expect((await getLayout("token-bob")).json()).toEqual(layout);
  });

  it("rejects unknown flow nodes and oversized metric ids", async () => {
    const badNode = await putLayout("token-bob", {
      widgets: [],
      flow: { toaster: { main: "power" } },
    });
    expect(badNode.statusCode).toBeGreaterThanOrEqual(400);
    expect(badNode.statusCode).toBeLessThan(500);

    const badId = await putLayout("token-bob", {
      widgets: [],
      flow: { battery: { main: "x".repeat(40) } },
    });
    expect(badId.statusCode).toBeGreaterThanOrEqual(400);
    expect(badId.statusCode).toBeLessThan(500);
  });

  it("overwrites on repeat saves and validates the payload", async () => {
    const put = await putLayout("token-bob", { widgets: [{ id: "live-flow", size: "full" }] });
    expect(put.statusCode).toBe(200);
    expect((await getLayout("token-bob")).json().widgets).toHaveLength(1);

    const bad = await putLayout("token-bob", { widgets: [{ id: "live-flow", size: "huge" }] });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.statusCode).toBeLessThan(500);
  });

  it("is invisible to non-members", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${envId}/layout`,
      headers: auth("token-alice"),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("grid quality per-phase stats", () => {
  // Gateway environments don't poll on their own, so the telemetry inserted
  // here is exactly what the endpoint sees.
  let threePhaseEnv: string;
  let singlePhaseEnv: string;

  beforeAll(async () => {
    const a = await createEnv("token-dave", { name: "3p grid env", sourceType: "gateway" });
    const b = await createEnv("token-dave", { name: "1p grid env", sourceType: "gateway" });
    threePhaseEnv = a.body.id as string;
    singlePhaseEnv = b.body.id as string;

    const now = Date.now();
    await db.insert(telemetry).values([
      // gridV doubles as L1 on 3-phase systems.
      { environmentId: threePhaseEnv, ts: new Date(now - 3 * 60000), gridV: 230, l1V: 230, l2V: 232, l3V: 228 },
      { environmentId: threePhaseEnv, ts: new Date(now - 2 * 60000), gridV: 231, l1V: 231, l2V: 233, l3V: 229 },
      // An outage sample: <50 V readings must not drag the stats down.
      { environmentId: threePhaseEnv, ts: new Date(now - 1 * 60000), gridV: 0, l1V: 0, l2V: 0, l3V: 0 },
      { environmentId: singlePhaseEnv, ts: new Date(now - 2 * 60000), gridV: 230 },
      { environmentId: singlePhaseEnv, ts: new Date(now - 1 * 60000), gridV: 234 },
    ]);
  });

  it("reports min/max/avg per phase on a 3-phase system", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${threePhaseEnv}/grid/quality?hours=24`,
      headers: auth("token-dave"),
    });
    expect(res.statusCode).toBe(200);
    const { stats } = res.json();
    expect(stats).toMatchObject({ minV: 230, maxV: 231, avgV: 230.5, samples: 2 });
    expect(stats.phases).toEqual({
      l1: { minV: 230, maxV: 231, avgV: 230.5 },
      l2: { minV: 232, maxV: 233, avgV: 232.5 },
      l3: { minV: 228, maxV: 229, avgV: 228.5 },
    });
  });

  it("reports no phases block on a single-phase system", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${singlePhaseEnv}/grid/quality?hours=24`,
      headers: auth("token-dave"),
    });
    expect(res.statusCode).toBe(200);
    const { stats } = res.json();
    expect(stats).toMatchObject({ minV: 230, maxV: 234, avgV: 232 });
    expect(stats.phases).toBeNull();
  });
});

describe("feedback form", () => {
  const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    server.app.inject({ method: "POST", url: "/api/feedback", payload, headers });

  it("system config advertises that feedback is enabled", async () => {
    const cfg = await server.app.inject({ url: "/api/system/config" });
    expect(cfg.json().feedbackEnabled).toBe(true);
  });

  it("delivers an anonymous visitor's message with their contact email", async () => {
    sentMail.length = 0;
    const res = await post({
      kind: "problem",
      message: "The dashboard shows no data since yesterday evening.",
      email: "visitor@example.com",
    });
    expect(res.statusCode).toBe(201);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe("davidlmen90@outlook.pt");
    expect(sentMail[0].subject).toContain("Problem report");
    expect(sentMail[0].subject).toContain("visitor@example.com");
    expect(sentMail[0].replyTo).toBe("visitor@example.com");
    expect(sentMail[0].text).toContain("no data since yesterday evening");
    expect(sentMail[0].text).toContain("(not signed in)");
  });

  it("attaches the signed-in account's email automatically", async () => {
    sentMail.length = 0;
    const res = await post(
      { kind: "suggestion", message: "Please add a weekly energy report email." },
      auth("token-alice"),
    );
    expect(res.statusCode).toBe(201);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].replyTo).toBe("alice@test.dev");
    expect(sentMail[0].text).toContain("Account: alice@test.dev");
  });

  it("an invalid token is treated as anonymous, not rejected", async () => {
    sentMail.length = 0;
    const res = await post(
      { kind: "help", message: "How do I pair the agent with my environment?" },
      auth("token-forged"),
    );
    expect(res.statusCode).toBe(201);
    expect(sentMail[0].text).toContain("(not signed in)");
  });

  it("validates the payload", async () => {
    for (const bad of [
      {},
      { kind: "rant", message: "0123456789" },
      { kind: "help", message: "short" },
      { kind: "help", message: "long enough message", email: "not-an-email" },
    ]) {
      const res = await post(bad);
      expect(res.statusCode).toBe(400);
    }
  });

  it("maps SMTP failures to a 502 instead of crashing", async () => {
    failNextMail = true;
    const res = await post({ kind: "problem", message: "This message will fail to send." });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("could not send");
  });

  it("returns 503 (and advertises it) when SMTP is not configured", async () => {
    const bare = await buildServer({
      db,
      verifier: new StaticVerifier(new Map(Object.entries(USERS))),
      withGateway: false,
      pollOpts: { pollIntervalMs: 1000, fullPollIntervalMs: 10000 },
      logLevel: "silent",
      sendMail: null,
    });
    try {
      const cfg = await bare.app.inject({ url: "/api/system/config" });
      expect(cfg.json().feedbackEnabled).toBe(false);
      const res = await bare.app.inject({
        method: "POST",
        url: "/api/feedback",
        payload: { kind: "help", message: "Is anybody out there listening?" },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await bare.manager.shutdown();
      await bare.app.close();
    }
  });
});

describe("account deletion", () => {
  it("deletes the whole account: owned environments, memberships, user row", async () => {
    // Dave owns an environment and shares it with Alice.
    const { status, body } = await createEnv("token-dave", { name: "Dave home" });
    expect(status).toBe(201);
    const daveEnvId = body.id as string;
    const share = await server.app.inject({
      method: "POST",
      url: `/api/environments/${daveEnvId}/members`,
      headers: auth("token-dave"),
      payload: { email: "alice@test.dev", role: "viewer" },
    });
    expect(share.statusCode).toBe(201);

    const del = await server.app.inject({
      method: "DELETE",
      url: "/api/account",
      headers: auth("token-dave"),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    // The environment is gone for everyone, including the member Alice.
    const forAlice = await server.app.inject({
      url: `/api/environments/${daveEnvId}`,
      headers: auth("token-alice"),
    });
    expect(forAlice.statusCode).toBe(404);

    // Dave's memberships went with the user row (his next request
    // re-creates a blank account with no environments).
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE u.firebase_uid = 'uid-dave'`,
    );
    expect(rows[0].n).toBe(0);
    const list = await server.app.inject({ url: "/api/environments", headers: auth("token-dave") });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
  });
});

describe("visit beacon and admin report", () => {
  it("records anonymous and signed-in visit beacons", async () => {
    const landing = await server.app.inject({
      method: "POST",
      url: "/api/visits",
      payload: { kind: "landing", sessionId: "sess-landing-1" },
    });
    expect(landing.statusCode).toBe(201);

    // Erin only exists for this suite, so she always has quota room.
    const { status, body } = await createEnv("token-erin", { name: "Erin beacon env" });
    expect(status).toBe(201);
    const app = await server.app.inject({
      method: "POST",
      url: "/api/visits",
      headers: auth("token-erin"),
      payload: { kind: "app", sessionId: "sess-app-1", envId: body.id },
    });
    expect(app.statusCode).toBe(201);

    const { rows } = await pool.query(
      "SELECT kind, session_id, user_id, environment_id FROM visits ORDER BY id",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "landing", session_id: "sess-landing-1", user_id: null });
    expect(rows[1].kind).toBe("app");
    expect(rows[1].user_id).not.toBeNull();
    expect(rows[1].environment_id).toBe(body.id);
  });

  it("rejects malformed beacons", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/visits",
      payload: { kind: "nope", sessionId: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/account/me reports admin status", async () => {
    const alice = await server.app.inject({ url: "/api/account/me", headers: auth("token-alice") });
    expect(alice.statusCode).toBe(200);
    expect(alice.json()).toMatchObject({ email: "alice@test.dev", admin: true });

    const bob = await server.app.inject({ url: "/api/account/me", headers: auth("token-bob") });
    expect(bob.json()).toMatchObject({ email: "bob@test.dev", admin: false });

    const anon = await server.app.inject({ url: "/api/account/me" });
    expect(anon.statusCode).toBe(401);
  });

  it("keeps non-admins out of the admin endpoints", async () => {
    for (const url of ["/api/admin/overview", "/api/admin/visits"]) {
      const asBob = await server.app.inject({ url, headers: auth("token-bob") });
      expect(asBob.statusCode).toBe(403);
      const anon = await server.app.inject({ url });
      expect(anon.statusCode).toBe(401);
    }
  });

  it("overview counts accounts, environments and connected sticks", async () => {
    // Give Erin's environment a stick that reported recently.
    await pool.query(
      `UPDATE environments SET logger_serial = 4242424242, logger_last_seen_at = now()
        WHERE name = 'Erin beacon env'`,
    );

    const res = await server.app.inject({ url: "/api/admin/overview", headers: auth("token-alice") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accounts.total).toBeGreaterThanOrEqual(2); // alice + bob at minimum
    expect(body.environments.total).toBeGreaterThanOrEqual(1);
    expect(body.environments.byType.simulator).toBeGreaterThanOrEqual(1);
    expect(body.sticks.connected).toBe(1);
    expect(body.sticks.owners).toBe(1);
  });

  it("aggregates visits by day, session funnel and world-map locations", async () => {
    // Two more hits from a public IP (the stubbed geo lookup says Lisbon).
    await db.insert(visits).values([
      { sessionId: "sess-landing-2", kind: "landing", ip: "203.0.113.5" },
      { sessionId: "sess-landing-2", kind: "app", ip: "203.0.113.5" },
    ]);

    const res = await server.app.inject({
      url: "/api/admin/visits?days=30",
      headers: auth("token-alice"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.days).toBe(30);
    expect(body.byDay).toHaveLength(30);
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = body.byDay.find((d: { date: string }) => d.date === today);
    expect(todayRow).toMatchObject({ landing: 2, app: 2 });

    // sess-landing-1 never opened an environment; the other two sessions did.
    expect(body.totals).toMatchObject({
      landing: 2,
      app: 2,
      sessions: 3,
      appSessions: 2,
      landingOnlySessions: 1,
    });

    // The two beacons from 127.0.0.1 are private (no location); the public
    // IP resolves through the stub and aggregates into one Lisbon bubble.
    expect(body.locations).toEqual([
      { lat: 38.72, lon: -9.14, city: "Lisbon", country: "Portugal", count: 2 },
    ]);
  });
});
