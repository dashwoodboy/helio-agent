/**
 * Startup seed tests: AUTH_MODE=disabled seeds a local user + simulator
 * environment on a fresh database, and startup never mutates existing data
 * — an environment switched to direct via the API must survive any number
 * of restarts (regression: the old bootstrap reverted it to gateway).
 *
 * Requires a Postgres reachable at TEST_DATABASE_ADMIN_URL (defaults to the
 * dev container on :55432). The test database is recreated each run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";

import { config } from "../src/config.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { environments } from "../src/db/schema.js";
import { LEGACY_ENV_ID } from "../src/auth/plugin.js";
import { seedLocalEnvironment } from "../src/runtime/bootstrap.js";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_bootstrap";
const SERIAL = 1134055009;

let db: Db;
let pool: pg.Pool;
let directEnvId: string;
const savedConfig = { ...config };

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

  // An environment whose owner switched it to direct polling via the API.
  const [row] = await db
    .insert(environments)
    .values({
      name: "Casa",
      timezone: "Europe/Lisbon",
      sourceType: "direct",
      loggerSerial: SERIAL,
      inverterIp: "188.80.14.71",
      inverterPort: 8899,
    })
    .returning({ id: environments.id });
  directEnvId = row.id;
}, 60000);

afterAll(async () => {
  Object.assign(config, savedConfig);
  await pool?.end();
});

async function directEnv() {
  const rows = await db.select().from(environments).where(eq(environments.id, directEnvId));
  return rows[0];
}

describe("startup seed", () => {
  it("does nothing in firebase mode", async () => {
    Object.assign(config, { authMode: "firebase" });
    await seedLocalEnvironment(db);
    const legacy = await db
      .select()
      .from(environments)
      .where(eq(environments.id, LEGACY_ENV_ID));
    expect(legacy).toHaveLength(0);
  });

  it("seeds a local simulator environment in disabled mode", async () => {
    Object.assign(config, { authMode: "disabled" });
    await seedLocalEnvironment(db);
    const [legacy] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, LEGACY_ENV_ID));
    expect(legacy).toMatchObject({ name: "Home", sourceType: "simulator" });
  });

  it("is insert-only: a renamed seeded environment survives a restart", async () => {
    await db
      .update(environments)
      .set({ name: "Renamed by the user" })
      .where(eq(environments.id, LEGACY_ENV_ID));
    await seedLocalEnvironment(db);
    const [legacy] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, LEGACY_ENV_ID));
    expect(legacy.name).toBe("Renamed by the user");
  });

  it("never touches an API-switched direct environment (regression)", async () => {
    for (const mode of ["disabled", "firebase"] as const) {
      Object.assign(config, { authMode: mode });
      await seedLocalEnvironment(db);
      const row = await directEnv();
      expect(row.sourceType, mode).toBe("direct");
      expect(row.inverterIp, mode).toBe("188.80.14.71");
      expect(row.inverterPort, mode).toBe(8899);
      expect(row.loggerSerial, mode).toBe(SERIAL);
    }
  });
});
