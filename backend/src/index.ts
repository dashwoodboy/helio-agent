import { config } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { seedLocalEnvironment } from "./runtime/bootstrap.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const { db } = createDb();

  const { app, manager, gateway, hub } = await buildServer({ db });

  app.log.info("Running database migrations...");
  await runMigrations(db);
  // Dev/e2e convenience only (AUTH_MODE=disabled): insert-only, no-op otherwise.
  await seedLocalEnvironment(db);

  // Start always-on environments (direct polling) and the idle sweep.
  await manager.start();

  // TCP gateway the Solarman sticks connect to ("Server B" mode).
  if (gateway) await gateway.listen();

  const shutdown = async () => {
    try {
      if (gateway) await gateway.close();
      await hub.closeAll();
      await manager.shutdown();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(
    `Deye backend listening on :${config.port} (auth=${config.authMode}, logger gateway :${config.loggerPort})`,
  );
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
