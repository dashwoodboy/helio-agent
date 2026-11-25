/**
 * Multi-tenant migration test: build a populated single-tenant database with
 * the first two migrations, then apply 0002_multi_tenant.sql and verify the
 * legacy environment backfill.
 *
 * Requires a Postgres reachable at TEST_DATABASE_ADMIN_URL (defaults to the
 * dev container on :55432).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_migration";
const LEGACY_ENV_ID = "00000000-0000-0000-0000-000000000001";
const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

let client: pg.Client;

async function applyMigration(file: string): Promise<void> {
  const sqlText = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  for (const statement of sqlText.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  client = new pg.Client({ connectionString: ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`) });
  await client.connect();
}, 30000);

afterAll(async () => {
  await client?.end();
});

describe("0002_multi_tenant migration", () => {
  it("has exactly the expected migration files in order", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files[0]).toMatch(/^0000_/);
    expect(files[1]).toMatch(/^0001_/);
    expect(files[2]).toMatch(/^0002_multi_tenant/);
  });

  it("backfills pre-existing single-tenant data into the legacy environment", async () => {
    // Single-tenant schema.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    await applyMigration(files[0]);
    await applyMigration(files[1]);

    // Legacy-looking data.
    await client.query(
      `INSERT INTO daily_energy (date, pv_kwh, load_kwh) VALUES ('2024-06-01', 21.5, 14.2), ('2024-06-02', 18.0, 12.9)`,
    );
    await client.query(`INSERT INTO settings (key, value) VALUES ('app', '{"pvKwp": 5.5}')`);
    await client.query(
      `INSERT INTO telemetry (ts, pv_w) VALUES ('2024-06-01T12:00:00Z', 3500)`,
    );
    await client.query(
      `INSERT INTO notifications (ts, rule, title) VALUES (now(), 'socLow', 'Low battery')`,
    );

    // Multi-tenant migration.
    await applyMigration(files[2]);

    // The legacy environment exists…
    const envs = await client.query(`SELECT id, source_type FROM environments`);
    expect(envs.rows).toEqual([{ id: LEGACY_ENV_ID, source_type: "direct" }]);

    // …and every pre-existing row belongs to it.
    for (const table of ["daily_energy", "settings", "telemetry", "notifications"]) {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE environment_id = $1`,
        [LEGACY_ENV_ID],
      );
      const total = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(res.rows[0].n, table).toBe(total.rows[0].n);
      expect(res.rows[0].n, table).toBeGreaterThan(0);
    }

    // environment_id is NOT NULL everywhere.
    const nullable = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'environment_id' AND is_nullable = 'YES'`,
    );
    expect(nullable.rows).toEqual([]);

    // Composite primary keys replaced the single-column ones.
    const pk = await client.query(
      `SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'daily_energy'::regclass AND i.indisprimary`,
    );
    expect(pk.rows[0].cols).toBe("date,environment_id");

    // Old rows can coexist with a second environment's rows for the same date.
    await client.query(
      `INSERT INTO environments (id, name) VALUES ('00000000-0000-0000-0000-000000000002', 'Other')`,
    );
    await client.query(
      `INSERT INTO daily_energy (environment_id, date, pv_kwh) VALUES ('00000000-0000-0000-0000-000000000002', '2024-06-01', 9.9)`,
    );
    const byDate = await client.query(
      `SELECT count(*)::int AS n FROM daily_energy WHERE date = '2024-06-01'`,
    );
    expect(byDate.rows[0].n).toBe(2);
  }, 30000);

  it("skips creating the legacy environment on a fresh database", async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}_fresh WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}_fresh`);
    await admin.end();

    const fresh = new pg.Client({
      connectionString: ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}_fresh`),
    });
    await fresh.connect();
    try {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
      for (const f of files) {
        const sqlText = await readFile(join(MIGRATIONS_DIR, f), "utf8");
        for (const statement of sqlText.split("--> statement-breakpoint")) {
          if (statement.trim()) await fresh.query(statement);
        }
      }
      const envs = await fresh.query(`SELECT count(*)::int AS n FROM environments`);
      expect(envs.rows[0].n).toBe(0);
    } finally {
      await fresh.end();
    }
  }, 30000);
});
