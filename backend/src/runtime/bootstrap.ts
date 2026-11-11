import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { environments, memberships, users } from "../db/schema.js";
import { LEGACY_ENV_ID } from "../auth/plugin.js";
import { LOCAL_USER } from "../auth/verifier.js";
import { isValidTimezone } from "../lib/time.js";

/**
 * Startup never mutates existing user data: connection details, source
 * types and locations are owned by the API (wizard, Settings switcher) and
 * schema/data changes ship as migrations. The one exception is seeding:
 * in AUTH_MODE=disabled (single-user dev/e2e) a fresh database gets a local
 * user and a simulator environment so the app works with zero setup. All
 * inserts are conflict-do-nothing, so reboots are no-ops.
 */
export async function seedLocalEnvironment(db: Db): Promise<void> {
  if (config.authMode !== "disabled") return;

  const [user] = await db
    .insert(users)
    .values({
      firebaseUid: LOCAL_USER.uid,
      email: LOCAL_USER.email,
      displayName: LOCAL_USER.displayName,
    })
    .onConflictDoUpdate({ target: users.firebaseUid, set: { email: LOCAL_USER.email } })
    .returning({ id: users.id });

  const tz =
    process.env.TZ && isValidTimezone(process.env.TZ) ? process.env.TZ : "Europe/Lisbon";
  await db
    .insert(environments)
    .values({
      id: LEGACY_ENV_ID,
      name: "Home",
      timezone: tz,
      lat: config.weatherLat,
      lon: config.weatherLon,
      sourceType: "simulator",
      createdBy: user.id,
    })
    .onConflictDoNothing();

  await db
    .insert(memberships)
    .values({ userId: user.id, environmentId: LEGACY_ENV_ID, role: "owner" })
    .onConflictDoNothing();
}
