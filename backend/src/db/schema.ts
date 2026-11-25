import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  bigserial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { InverterConfig } from "../inverter/types.js";

// ----------------------------------------------------------------- tenants

/** One row per Firebase account. */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    firebaseUid: text("firebase_uid").notNull(),
    email: text("email").notNull().default(""),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_firebase_uid_idx").on(t.firebaseUid)],
);

export type EnvironmentSourceType = "gateway" | "direct" | "simulator" | "agent";
export type MembershipRole = "owner" | "installer" | "viewer";

/**
 * A paired Helio Agent: the desktop app that discovers Solarman sticks on a
 * user's LAN and relays them to this server over an outbound WebSocket.
 * The token is stored only as a SHA-256 hash; revoking sets revokedAt and
 * kicks the live connection.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Device name shown in the UI (e.g. "David's MacBook"). */
    name: text("name").notNull(),
    /** "windows" | "macos" | "linux" (free-form, display only). */
    platform: text("platform").notNull().default(""),
    /** Agent app version from the last hello (display + outdated warnings). */
    version: text("version").notNull().default(""),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agents_token_hash_idx").on(t.tokenHash),
    index("agents_user_idx").on(t.userId),
  ],
);

export type AgentRow = typeof agents.$inferSelect;

/** An installation: one inverter (or simulator) plus all its history. */
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    lat: real("lat").notNull().default(0),
    lon: real("lon").notNull().default(0),
    /** gateway = stick connects to us | direct = we connect out | agent = via a Helio Agent | simulator */
    sourceType: text("source_type").$type<EnvironmentSourceType>().notNull().default("gateway"),
    /** Solarman logger serial claimed by this environment (gateway/direct/agent modes). */
    loggerSerial: bigint("logger_serial", { mode: "number" }),
    /** The Helio Agent this environment's stick is reached through (agent mode). */
    agentId: uuid("agent_id").references(() => agents.id),
    loggerLastSeenAt: timestamp("logger_last_seen_at", { withTimezone: true }),
    /** Inverter/stick address for direct mode (set via the wizard or env vars). */
    inverterIp: text("inverter_ip"),
    inverterPort: integer("inverter_port"),
    /** Detected capabilities, cached across restarts. */
    inverterConfig: jsonb("inverter_config").$type<InverterConfig>(),
    /**
     * Unguessable token for the public read-only share link
     * (/shared/<token>); null = sharing disabled. Owner-managed.
     */
    shareToken: text("share_token"),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("environments_logger_serial_idx").on(t.loggerSerial)],
);

export const memberships = pgTable(
  "memberships",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.environmentId] }),
    index("memberships_env_idx").on(t.environmentId),
  ],
);

// --------------------------------------------------------------- telemetry

/** 1-minute averaged samples. Pruned after ~13 months. */
export const telemetry = pgTable(
  "telemetry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    pv1W: integer("pv1_w").notNull().default(0),
    pv2W: integer("pv2_w").notNull().default(0),
    pvW: integer("pv_w").notNull().default(0),
    loadW: integer("load_w").notNull().default(0),
    /** + importing / - exporting */
    gridW: integer("grid_w").notNull().default(0),
    /** + charging / - discharging */
    battW: integer("batt_w").notNull().default(0),
    battV: real("batt_v"),
    battA: real("batt_a"),
    soc: real("soc"),
    gridV: real("grid_v"),
    gridHz: real("grid_hz"),
    genW: integer("gen_w").notNull().default(0),
    dcTemp: real("dc_temp"),
    heatsinkTemp: real("heatsink_temp"),
    l1W: integer("l1_w"),
    l2W: integer("l2_w"),
    l3W: integer("l3_w"),
    l1V: real("l1_v"),
    l2V: real("l2_v"),
    l3V: real("l3_v"),
  },
  (t) => [index("telemetry_env_ts_idx").on(t.environmentId, t.ts)],
);

/** One row per local day. Daily counters from the inverter are authoritative. */
export const dailyEnergy = pgTable(
  "daily_energy",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    pvKwh: real("pv_kwh").notNull().default(0),
    importKwh: real("import_kwh").notNull().default(0),
    exportKwh: real("export_kwh").notNull().default(0),
    loadKwh: real("load_kwh").notNull().default(0),
    battChargeKwh: real("batt_charge_kwh").notNull().default(0),
    battDischargeKwh: real("batt_discharge_kwh").notNull().default(0),
    genKwh: real("gen_kwh").notNull().default(0),
    // Energy-flow attribution (integrated from telemetry)
    pvToLoadKwh: real("pv_to_load_kwh").notNull().default(0),
    pvToBattKwh: real("pv_to_batt_kwh").notNull().default(0),
    pvToGridKwh: real("pv_to_grid_kwh").notNull().default(0),
    gridToLoadKwh: real("grid_to_load_kwh").notNull().default(0),
    gridToBattKwh: real("grid_to_batt_kwh").notNull().default(0),
    battToLoadKwh: real("batt_to_load_kwh").notNull().default(0),
    // Battery-charge source split (generator measured, AC-coupled PV estimated)
    genToBattKwh: real("gen_to_batt_kwh").notNull().default(0),
    acPvToBattKwh: real("ac_pv_to_batt_kwh").notNull().default(0),
    // Import split for day/night tariffs
    importDayKwh: real("import_day_kwh").notNull().default(0),
    importNightKwh: real("import_night_kwh").notNull().default(0),
    /** Imported energy per half-hour slot (48 values, kWh) for custom tariffs. */
    importSlotsKwh: jsonb("import_slots_kwh").$type<number[]>(),
    peakPvW: integer("peak_pv_w").notNull().default(0),
    peakLoadW: integer("peak_load_w").notNull().default(0),
    l1Kwh: real("l1_kwh").notNull().default(0),
    l2Kwh: real("l2_kwh").notNull().default(0),
    l3Kwh: real("l3_kwh").notNull().default(0),
    socMin: real("soc_min"),
    socMax: real("soc_max"),
    battVMin: real("batt_v_min"),
    battVMax: real("batt_v_max"),
    /** counters | integrated | seed */
    source: text("source").notNull().default("integrated"),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.date] })],
);

export const outageEvents = pgTable(
  "outage_events",
  {
    id: serial("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationS: integer("duration_s"),
    minSoc: real("min_soc"),
  },
  (t) => [index("outage_env_started_idx").on(t.environmentId, t.startedAt)],
);

export const generatorSessions = pgTable(
  "generator_sessions",
  {
    id: serial("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    runtimeS: integer("runtime_s"),
    energyKwh: real("energy_kwh").notNull().default(0),
    avgW: integer("avg_w"),
  },
  (t) => [index("gen_env_started_idx").on(t.environmentId, t.startedAt)],
);

export const dailyWeather = pgTable(
  "daily_weather",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    weatherCode: integer("weather_code"),
    tempMax: real("temp_max"),
    tempMin: real("temp_min"),
    precipMm: real("precip_mm"),
    /** Daily tilted-irradiance sum, kWh/m2 */
    radiationKwhM2: real("radiation_kwh_m2"),
    forecastPvKwh: real("forecast_pv_kwh"),
    actualPvKwh: real("actual_pv_kwh"),
    sunrise: text("sunrise"),
    sunset: text("sunset"),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.date] })],
);

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    rule: text("rule").notNull(),
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    read: boolean("read").notNull().default(false),
    /**
     * Stable content key for same-day dedupe (e.g. "wind|critical|2026-11-12"
     * for a storm warning). Empty for alerts that dedupe on the rule alone.
     */
    signature: text("signature").notNull().default(""),
  },
  (t) => [index("notifications_env_ts_idx").on(t.environmentId, t.ts)],
);

export const settings = pgTable(
  "settings",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.key] })],
);

/** Instance-wide key/value store (e.g. the VAPID key pair for web push). */
export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export type WidgetSize = "sm" | "lg" | "full";
export type FlowNodeId = "solar" | "battery" | "grid" | "home" | "gen";
export interface DashboardLayout {
  widgets: { id: string; size: WidgetSize }[];
  /**
   * Which metric each energy-flow circle shows: a main (big number) and an
   * optional secondary line. Metric ids live in the frontend catalog;
   * unknown ids are simply ignored there, so no migration is needed.
   */
  flow?: Partial<Record<FlowNodeId, { main?: string; sub?: string }>>;
}

/** Each member's own dashboard arrangement for an environment. */
export const dashboardLayouts = pgTable(
  "dashboard_layouts",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    layout: jsonb("layout").$type<DashboardLayout>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.userId] })],
);

/** One applied (or attempted) inverter-settings change, for auditing. */
export interface InverterChangeField {
  field: string;
  from: unknown;
  to: unknown;
  ok: boolean;
  error?: string;
}

export const inverterChanges = pgTable(
  "inverter_changes",
  {
    id: serial("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    fields: jsonb("fields").$type<InverterChangeField[]>().notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
  },
  (t) => [index("inverter_changes_env_ts_idx").on(t.environmentId, t.ts)],
);

/**
 * A saved inverter configuration (profile) for an environment: a named
 * partial settings patch of the safe operational fields (behaviour, battery
 * limits, time-of-use). Applying one goes through the normal guarded
 * settings write, so profiles are plain data here.
 */
export const inverterProfiles = pgTable(
  "inverter_profiles",
  {
    id: serial("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inverter_profiles_env_name_idx").on(t.environmentId, t.name)],
);

// ------------------------------------------------------------ admin report

export type VisitKind = "landing" | "app";

/**
 * One beacon per browser session per kind: "landing" when the public site
 * loads, "app" when an environment is opened. Feeds the admin report only;
 * pruned after ~180 days.
 */
export const visits = pgTable(
  "visits",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** Random per-browser-session id so landing→app funnels can be joined. */
    sessionId: text("session_id").notNull(),
    kind: text("kind").$type<VisitKind>().notNull(),
    environmentId: uuid("environment_id"),
    userId: integer("user_id"),
    ip: text("ip").notNull().default(""),
  },
  (t) => [index("visits_ts_idx").on(t.ts), index("visits_session_idx").on(t.sessionId)],
);

/** Cached IP geolocation for the admin world map (resolved lazily). */
export const ipGeo = pgTable("ip_geo", {
  ip: text("ip").primaryKey(),
  lat: real("lat"),
  lon: real("lon"),
  city: text("city").notNull().default(""),
  country: text("country").notNull().default(""),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One web-push subscription per browser/device, owned by a user. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint)],
);
