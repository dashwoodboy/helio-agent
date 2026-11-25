/**
 * Inverter settings API tests, against a simulator environment (whose
 * control is an in-memory register bank running the real codec/write path).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { memberships } from "../src/db/schema.js";
import { StaticVerifier, type AuthUser } from "../src/auth/verifier.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { config } from "../src/config.js";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_inverter_api";

const USERS: Record<string, AuthUser> = {
  "token-owner": { uid: "uid-owner", email: "owner@test.dev", emailVerified: true, displayName: "Owner" },
  "token-viewer": { uid: "uid-viewer", email: "viewer@test.dev", emailVerified: true, displayName: "Viewer" },
};

let server: BuiltServer;
let db: Db;
let pool: pg.Pool;
let envId: string;
let gatewayEnvId: string;

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

  const createEnv = async (sourceType: "simulator" | "gateway") => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-owner"),
      payload: { name: `Inv ${sourceType}`, timezone: "Europe/Lisbon", lat: 38.7, lon: -9.1, sourceType },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  envId = await createEnv("simulator");
  gatewayEnvId = await createEnv("gateway");

  // Viewer membership on the simulator environment.
  const list = await server.app.inject({ url: "/api/environments", headers: auth("token-viewer") });
  expect(list.statusCode).toBe(200);
  const [{ id: viewerId }] = (
    await pool.query(`SELECT id FROM users WHERE firebase_uid = 'uid-viewer'`)
  ).rows;
  await db.insert(memberships).values({ userId: viewerId, environmentId: envId, role: "viewer" });
}, 60000);

afterAll(async () => {
  await server?.manager.shutdown();
  await server?.app.close();
  await pool?.end();
});

describe("GET /inverter/settings", () => {
  it("returns the full settings for a member", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth("token-viewer"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ supported: true, online: true, writesEnabled: true });
    expect(body.settings.loadLimit).toBe("zeroExport");
    expect(body.settings.touSlots).toHaveLength(6);
    expect(body.ratedPowerW).toBe(6000);
    expect(body.limits.maxSellPowerW).toEqual({ min: 0, max: 6000 });
    expect(body.unsupported).toEqual([]);
  });

  it("is hidden from non-members", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${gatewayEnvId}/inverter/settings`,
      headers: auth("token-viewer"),
    });
    expect(res.statusCode).toBe(404);
  });

  it("reports offline for a gateway environment without a stick", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${gatewayEnvId}/inverter/settings`,
      headers: auth("token-owner"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ supported: true, online: false, reason: "offline" });
  });
});

describe("PUT /inverter/settings", () => {
  it("rejects viewers with 403", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth("token-viewer"),
      payload: { priorityLoad: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("applies a change, verifies it, and audits it", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth("token-owner"),
      payload: {
        priorityLoad: true,
        maxSellPowerW: 5000,
        touSlots: [null, { time: "04:30", charge: "grid" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(4);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(body.read.settings).toMatchObject({ priorityLoad: true, maxSellPowerW: 5000 });
    expect(body.read.settings.touSlots[1]).toMatchObject({ time: "04:30", charge: "grid" });

    const { rows } = await pool.query(
      `SELECT fields, ok FROM inverter_changes WHERE environment_id = $1 ORDER BY id DESC LIMIT 1`,
      [envId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    const fields = rows[0].fields as { field: string; from: unknown; to: unknown }[];
    expect(fields.map((f) => f.field).sort()).toEqual(
      ["maxSellPowerW", "priorityLoad", "touSlots.1.charge", "touSlots.1.time"],
    );
    expect(fields.find((f) => f.field === "priorityLoad")).toMatchObject({ from: false, to: true });
  });

  it("rejects unknown fields (400 via zod)", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth("token-owner"),
      payload: { warpDrive: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects cross-field violations with 400 and issue details", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth("token-owner"),
      payload: { battShutdownPct: 40, battLowPct: 20 },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().issues[0])).toContain("shutdown SOC");
  });

  it("rejects out-of-range values against rated power", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth("token-owner"),
      payload: { maxSellPowerW: 9000 }, // rated 6000
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().issues[0])).toContain("between 0 and 6000");
  });

  it("returns 409 when the inverter is offline", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${gatewayEnvId}/inverter/settings`,
      headers: auth("token-owner"),
      payload: { priorityLoad: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("offline");
  });

  it("returns 409 on 3-phase inverters", async () => {
    const rt = await server.manager.get(envId);
    const was = rt!.inverterConfig.phases;
    rt!.inverterConfig = { ...rt!.inverterConfig, phases: 3 };
    try {
      const res = await server.app.inject({
        method: "PUT",
        url: `/api/environments/${envId}/inverter/settings`,
        headers: auth("token-owner"),
        payload: { priorityLoad: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("1-phase");

      const read = await server.app.inject({
        url: `/api/environments/${envId}/inverter/settings`,
        headers: auth("token-owner"),
      });
      expect(read.json()).toMatchObject({ supported: false, reason: "threePhase" });
    } finally {
      rt!.inverterConfig = { ...rt!.inverterConfig, phases: was };
    }
  });

  it("the kill switch blocks writes with 403 but keeps reads working", async () => {
    config.inverterWritesEnabled = false;
    try {
      const put = await server.app.inject({
        method: "PUT",
        url: `/api/environments/${envId}/inverter/settings`,
        headers: auth("token-owner"),
        payload: { priorityLoad: false },
      });
      expect(put.statusCode).toBe(403);
      expect(put.json().error).toContain("disabled");

      const read = await server.app.inject({
        url: `/api/environments/${envId}/inverter/settings`,
        headers: auth("token-owner"),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ supported: true, online: true, writesEnabled: false });
    } finally {
      config.inverterWritesEnabled = true;
    }
  });
});

describe("POST /inverter/clock", () => {
  it("sets the clock to the environment's local time and audits it", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/inverter/clock`,
      headers: auth("token-owner"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().clock).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const read = await server.app.inject({
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth("token-owner"),
    });
    expect(read.json().settings.clock.slice(0, 15)).toBe(res.json().clock.slice(0, 15));
  });

  it("is viewer-forbidden", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/inverter/clock`,
      headers: auth("token-viewer"),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("inverter profiles CRUD", () => {
  const SETTINGS = {
    priorityLoad: false,
    gridChargeEnabled: true,
    useTimer: true,
    touSlots: [null, { capacityPct: 100, charge: "grid" }],
  };

  it("starts empty and viewers can list", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-viewer"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("creates, lists, updates and deletes a profile (installer+)", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-owner"),
      payload: { name: "Bad weather", settings: SETTINGS },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    expect(created.json()).toMatchObject({ name: "Bad weather", settings: SETTINGS });

    const list = await server.app.inject({
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-owner"),
    });
    expect(list.json()).toHaveLength(1);

    const renamed = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/inverter/profiles/${id}`,
      headers: auth("token-owner"),
      payload: { name: "Storm prep", settings: { ...SETTINGS, gridChargeA: 40 } },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Storm prep" });
    expect(renamed.json().settings.gridChargeA).toBe(40);

    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${envId}/inverter/profiles/${id}`,
      headers: auth("token-owner"),
    });
    expect(deleted.statusCode).toBe(200);
    const after = await server.app.inject({
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-owner"),
    });
    expect(after.json()).toEqual([]);
  });

  it("rejects duplicate names with 409", async () => {
    const make = () =>
      server.app.inject({
        method: "POST",
        url: `/api/environments/${envId}/inverter/profiles`,
        headers: auth("token-owner"),
        payload: { name: "Twice", settings: { solarSell: true } },
      });
    expect((await make()).statusCode).toBe(201);
    const dup = await make();
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toContain("already exists");
  });

  it("rejects unsafe fields (advanced/hardware) with 400", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-owner"),
      payload: { name: "Nope", settings: { battFloatV: 53.2 } },
    });
    expect(res.statusCode).toBe(400);
    const off = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-owner"),
      payload: { name: "Nope", settings: { inverterEnabled: false } },
    });
    expect(off.statusCode).toBe(400);
  });

  it("viewers cannot create, and other environments cannot touch it", async () => {
    const asViewer = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-viewer"),
      payload: { name: "Viewer try", settings: {} },
    });
    expect(asViewer.statusCode).toBe(403);

    // A profile in envId is invisible through gatewayEnvId (owner of both).
    const created = await server.app.inject({
      method: "POST",
      url: `/api/environments/${envId}/inverter/profiles`,
      headers: auth("token-owner"),
      payload: { name: "Mine", settings: { solarSell: false } },
    });
    const id = created.json().id as number;
    const crossUpdate = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${gatewayEnvId}/inverter/profiles/${id}`,
      headers: auth("token-owner"),
      payload: { name: "Stolen" },
    });
    expect(crossUpdate.statusCode).toBe(404);
    const crossDelete = await server.app.inject({
      method: "DELETE",
      url: `/api/environments/${gatewayEnvId}/inverter/profiles/${id}`,
      headers: auth("token-owner"),
    });
    expect(crossDelete.statusCode).toBe(404);
  });
});

describe("GET /inverter/changes", () => {
  it("lists the audit log, newest first, with the author", async () => {
    const res = await server.app.inject({
      url: `/api/environments/${envId}/inverter/changes`,
      headers: auth("token-viewer"),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.length).toBeGreaterThanOrEqual(2); // settings PUT + clock
    expect(rows[0]).toMatchObject({ ok: true, userEmail: "owner@test.dev" });
    expect(rows[0].fields[0].field).toBe("clock");
  });
});
