/**
 * Logger gateway end-to-end: a fake Solarman stick (scripts/fake-logger.ts)
 * connects to a real LoggerGateway; claimed serials are attached to their
 * environment runtime, which detects capabilities and polls live data over
 * the inbound session.
 *
 * Requires a Postgres reachable at TEST_DATABASE_ADMIN_URL (defaults to the
 * dev container on :55432).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { environments, memberships, users } from "../src/db/schema.js";
import { LoggerGateway } from "../src/gateway/server.js";
import { RuntimeManager } from "../src/runtime/manager.js";
import { startFakeLogger, type FakeLoggerHandle } from "../scripts/fake-logger.js";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_gateway";
const PORT = 20000 + Math.floor(Math.random() * 20000);

const CLAIMED_SERIAL = 2712345678;
const UNKNOWN_SERIAL = 2799999999;
const TLS_SERIAL = 2755555555;

const silentLog = { info: () => undefined, warn: () => undefined };

let db: Db;
let pool: pg.Pool;
let manager: RuntimeManager;
let gateway: LoggerGateway;
let envId: string;
const sticks: FakeLoggerHandle[] = [];

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const created = createDb(ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`));
  db = created.db;
  pool = created.pool;
  await runMigrations(db, 1);

  const [user] = await db
    .insert(users)
    .values({ firebaseUid: "uid-test", email: "gw@test.dev" })
    .returning({ id: users.id });
  const [env] = await db
    .insert(environments)
    .values({
      name: "Gateway env",
      timezone: "Europe/Lisbon",
      sourceType: "gateway",
      loggerSerial: CLAIMED_SERIAL,
      createdBy: user.id,
    })
    .returning({ id: environments.id });
  envId = env.id;
  await db.insert(memberships).values({ userId: user.id, environmentId: envId, role: "owner" });

  manager = new RuntimeManager(db, silentLog, { pollIntervalMs: 300, fullPollIntervalMs: 2000 });
  gateway = new LoggerGateway(manager, silentLog, { port: PORT });
  await gateway.listen();
}, 60000);

afterAll(async () => {
  for (const s of sticks) s.stop();
  await gateway?.close();
  await manager?.shutdown();
  await pool?.end();
});

describe("logger gateway", () => {
  it("attaches a claimed stick and polls live data through it", async () => {
    const stick = await startFakeLogger({
      host: "127.0.0.1",
      port: PORT,
      serial: CLAIMED_SERIAL,
      heartbeatMs: 2000,
    });
    sticks.push(stick);

    await waitFor(() => gateway.isConnected(CLAIMED_SERIAL), 10000, "stick to connect");
    // The runtime detects capabilities (1-phase, battery) over the session
    // and the poller produces a live snapshot.
    await waitFor(
      async () => {
        const rt = await manager.get(envId);
        return rt?.liveState.current !== null;
      },
      20000,
      "live snapshot via inbound session",
    );

    const rt = (await manager.get(envId))!;
    expect(rt.inverterConfig.phases).toBe(1);
    expect(rt.inverterConfig.hasBattery).toBe(true);
    const snap = rt.liveState.current!;
    expect(snap.soc).toBeGreaterThanOrEqual(0);
    expect(snap.soc).toBeLessThanOrEqual(100);
    expect(Number.isFinite(snap.loadW)).toBe(true);

    // The sighting timestamp was recorded.
    const [{ logger_last_seen_at }] = (
      await pool.query(`SELECT logger_last_seen_at FROM environments WHERE id = $1`, [envId])
    ).rows;
    expect(logger_last_seen_at).not.toBeNull();
  }, 40000);

  it("keeps unknown serials unattached and offers them to the claim wizard", async () => {
    const stick = await startFakeLogger({
      host: "127.0.0.1",
      port: PORT,
      serial: UNKNOWN_SERIAL,
      heartbeatMs: 2000,
    });
    sticks.push(stick);

    await waitFor(() => gateway.isConnected(UNKNOWN_SERIAL), 10000, "unknown stick to connect");
    // No environment claimed it: attach must be false and the sighting listed.
    expect(await gateway.tryAttach(UNKNOWN_SERIAL)).toBe(false);
    const localIps = ["127.0.0.1", "::ffff:127.0.0.1", "::1"];
    const seen = localIps.flatMap((ip) => gateway.unclaimedForIp(ip));
    expect(seen).toContain(UNKNOWN_SERIAL);

    // After claiming the serial, tryAttach succeeds against the live session.
    const [user] = (await pool.query(`SELECT id FROM users LIMIT 1`)).rows;
    const [env] = (
      await pool.query(
        `INSERT INTO environments (name, timezone, source_type, logger_serial, created_by)
         VALUES ('Second env', 'Europe/Lisbon', 'gateway', $1, $2) RETURNING id`,
        [UNKNOWN_SERIAL, user.id],
      )
    ).rows;
    await pool.query(
      `INSERT INTO memberships (user_id, environment_id, role) VALUES ($1, $2, 'owner')`,
      [user.id, env.id],
    );
    expect(await gateway.tryAttach(UNKNOWN_SERIAL)).toBe(true);
  }, 40000);

  it("accepts TLS-wrapped sticks on the same port (newer LSW5 firmwares)", async () => {
    const [user] = (await pool.query(`SELECT id FROM users LIMIT 1`)).rows;
    const [env] = (
      await pool.query(
        `INSERT INTO environments (name, timezone, source_type, logger_serial, created_by)
         VALUES ('TLS env', 'Europe/Lisbon', 'gateway', $1, $2) RETURNING id`,
        [TLS_SERIAL, user.id],
      )
    ).rows;
    await pool.query(
      `INSERT INTO memberships (user_id, environment_id, role) VALUES ($1, $2, 'owner')`,
      [user.id, env.id],
    );

    const stick = await startFakeLogger({
      host: "127.0.0.1",
      port: PORT,
      serial: TLS_SERIAL,
      heartbeatMs: 2000,
      tls: true,
    });
    sticks.push(stick);

    await waitFor(() => gateway.isConnected(TLS_SERIAL), 15000, "TLS stick to connect");
    // Live polling works through the TLS session exactly like a plain one.
    await waitFor(
      async () => {
        const rt = await manager.get(env.id);
        return rt?.liveState.current !== null;
      },
      20000,
      "live snapshot via TLS session",
    );
  }, 40000);

  it("reads and writes inverter settings through the inbound session", async () => {
    // The claimed stick from the first test is attached and polling.
    const rt = (await manager.get(envId))!;
    await waitFor(() => rt.control !== null, 10000, "control to attach");

    const read = await rt.control!.readSettings();
    expect(read.settings.loadLimit).toBe("zeroExport");
    expect(read.settings.touSlots).toHaveLength(6);
    expect(read.ratedPowerW).toBe(6000);

    // A write lands in the stick's settings bank, is verified by read-back,
    // and interleaves safely with the live poller on the same session.
    const result = await rt.control!.applySettings({
      priorityLoad: true,
      gridChargeA: 55,
      touSlots: [{ time: "01:30", sell: true }],
    });
    expect(result.ok).toBe(true);
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(result.read.settings).toMatchObject({ priorityLoad: true, gridChargeA: 55 });
    expect(result.read.settings.touSlots![0]).toMatchObject({ time: "01:30", sell: true });

    const stickBank = sticks[0].registers;
    expect(stickBank.get(243)).toBe(1); // priority load bit
    expect(stickBank.get(230)).toBe(55);
    expect(stickBank.get(250)).toBe(130); // 01:30 → HHMM
    expect((stickBank.get(274)! & 0x40) !== 0).toBe(true); // sell bit, mode preserved
    expect(stickBank.get(274)! & 0x1c).toBe(4); // general mode untouched

    // Polling kept working around the writes.
    expect(rt.liveState.current).not.toBeNull();
  }, 40000);

  it("reports a Modbus exception when writing an unknown register", async () => {
    const rt = (await manager.get(envId))!;
    // Remove the register from the stick's bank: reads still cover the block
    // (gap-filled with 0) but the write is answered with a Modbus exception.
    sticks[0].registers.delete(206);
    const result = await rt.control!.applySettings({ gridTrickleFeedW: 100 });
    expect(result.ok).toBe(false);
    expect(result.results[0].ok).toBe(false);
  }, 40000);

  it("replaces the session when the same serial reconnects", async () => {
    const first = sticks[0];
    expect(gateway.isConnected(CLAIMED_SERIAL)).toBe(true);

    const closed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
    const second = await startFakeLogger({
      host: "127.0.0.1",
      port: PORT,
      serial: CLAIMED_SERIAL,
      heartbeatMs: 2000,
    });
    sticks.push(second);

    await closed; // old session is force-closed by the gateway
    await waitFor(() => gateway.isConnected(CLAIMED_SERIAL), 10000, "replacement session");
    expect(second.socket.destroyed).toBe(false);
  }, 30000);
});
