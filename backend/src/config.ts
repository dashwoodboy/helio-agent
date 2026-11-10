import "dotenv/config";

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return ["true", "1", "yes"].includes(v.toLowerCase());
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : fallback;
}

export interface CapabilityOverrides {
  phases?: 1 | 3;
  hasBattery?: boolean;
  pvStrings?: 1 | 2;
  hasGenerator?: boolean;
}

export const config = {
  port: num(process.env.PORT, 3001),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://deye:deye@localhost:55432/deye",

  pollIntervalMs: Math.max(1000, num(process.env.POLL_INTERVAL_MS, 5000)),
  fullPollIntervalMs: Math.max(10000, num(process.env.FULL_POLL_INTERVAL_MS, 60000)),

  /**
   * Kill switch for inverter settings writes (the Inverter page). When off,
   * the settings API stays readable but every write returns 403.
   */
  inverterWritesEnabled: bool(process.env.INVERTER_WRITES_ENABLED, true),

  weatherLat: num(process.env.WEATHER_LAT, 49.8397),
  weatherLon: num(process.env.WEATHER_LON, 24.0297),

  // --- Auth ---
  /** Firebase project id; required unless AUTH_MODE=disabled. */
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "",
  /** "firebase" (default) or "disabled" (single-user dev/e2e mode). */
  authMode: (process.env.AUTH_MODE ?? "firebase") as "firebase" | "disabled",
  /** This email becomes owner of the migrated legacy environment on first login. */
  bootstrapOwnerEmail: (process.env.BOOTSTRAP_OWNER_EMAIL ?? "").toLowerCase(),
  maxEnvironmentsPerUser: num(process.env.MAX_ENVIRONMENTS_PER_USER, 3),
  /** Comma-separated allowed browser origins; empty = same-origin only. */
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** API requests allowed per IP per minute (raise for e2e runs, which hammer one IP). */
  rateLimitMax: num(process.env.RATE_LIMIT_MAX, 300),

  // --- Logger gateway (sticks connect here in "Server B" mode) ---
  loggerPort: num(process.env.LOGGER_PORT, 10000),
  /** Host + port shown to users in the "connect your stick" wizard. */
  publicLoggerHost: process.env.PUBLIC_LOGGER_HOST ?? "",
  publicLoggerPort: num(process.env.PUBLIC_LOGGER_PORT, num(process.env.LOGGER_PORT, 10000)),
  /**
   * Optional real TLS certificate for the gateway (fullchain + key PEM files).
   * Newer sticks validate the server certificate against public CAs, so a
   * publicly-trusted cert is required for them; without these a self-signed
   * cert is generated (works only for firmwares that skip validation).
   */
  gatewayTlsCertFile: process.env.GATEWAY_TLS_CERT_FILE ?? "",
  gatewayTlsKeyFile: process.env.GATEWAY_TLS_KEY_FILE ?? "",

  // --- Helio Agent (desktop app relaying LAN sticks) ---
  /** Base URL where the agent installers are hosted (shown in the picker). */
  agentDownloadBaseUrl: process.env.AGENT_DOWNLOAD_BASE_URL ?? "",
  /**
   * Reject agent pairing / WebSocket requests that did not arrive over HTTPS
   * (checked via X-Forwarded-Proto behind the nginx TLS proxy). Defaults to
   * on for production multi-user deployments; LAN-only self-hosters on plain
   * HTTP can disable it.
   */
  agentRequireTls: bool(
    process.env.AGENT_REQUIRE_TLS,
    (process.env.AUTH_MODE ?? "firebase") === "firebase" && process.env.NODE_ENV === "production",
  ),
  /** Paired agents allowed per account. */
  maxAgentsPerUser: num(process.env.MAX_AGENTS_PER_USER, 5),

  capabilityOverrides: {
    phases: process.env.INVERTER_PHASES
      ? (num(process.env.INVERTER_PHASES, 1) as 1 | 3)
      : undefined,
    hasBattery: process.env.INVERTER_HAS_BATTERY
      ? bool(process.env.INVERTER_HAS_BATTERY)
      : undefined,
    pvStrings: process.env.INVERTER_PV_STRINGS
      ? (num(process.env.INVERTER_PV_STRINGS, 2) as 1 | 2)
      : undefined,
    hasGenerator: process.env.INVERTER_HAS_GENERATOR
      ? bool(process.env.INVERTER_HAS_GENERATOR)
      : undefined,
  } satisfies CapabilityOverrides,
};

export const APP_VERSION = "1.4.2";
