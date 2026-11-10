import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "./client.js";

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

/** Run pending migrations; retries while Postgres is still starting up. */
export async function runMigrations(db: Db, attempts = 15): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await migrate(db, { migrationsFolder });
      return;
    } catch (err) {
      if (i === attempts) throw err;
      const wait = Math.min(5000, i * 1000);
      console.warn(`Migration attempt ${i} failed (${(err as Error).message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
