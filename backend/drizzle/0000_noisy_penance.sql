CREATE TABLE "daily_energy" (
	"date" date PRIMARY KEY NOT NULL,
	"pv_kwh" real DEFAULT 0 NOT NULL,
	"import_kwh" real DEFAULT 0 NOT NULL,
	"export_kwh" real DEFAULT 0 NOT NULL,
	"load_kwh" real DEFAULT 0 NOT NULL,
	"batt_charge_kwh" real DEFAULT 0 NOT NULL,
	"batt_discharge_kwh" real DEFAULT 0 NOT NULL,
	"gen_kwh" real DEFAULT 0 NOT NULL,
	"pv_to_load_kwh" real DEFAULT 0 NOT NULL,
	"pv_to_batt_kwh" real DEFAULT 0 NOT NULL,
	"pv_to_grid_kwh" real DEFAULT 0 NOT NULL,
	"grid_to_load_kwh" real DEFAULT 0 NOT NULL,
	"grid_to_batt_kwh" real DEFAULT 0 NOT NULL,
	"batt_to_load_kwh" real DEFAULT 0 NOT NULL,
	"import_day_kwh" real DEFAULT 0 NOT NULL,
	"import_night_kwh" real DEFAULT 0 NOT NULL,
	"peak_pv_w" integer DEFAULT 0 NOT NULL,
	"peak_load_w" integer DEFAULT 0 NOT NULL,
	"l1_kwh" real DEFAULT 0 NOT NULL,
	"l2_kwh" real DEFAULT 0 NOT NULL,
	"l3_kwh" real DEFAULT 0 NOT NULL,
	"soc_min" real,
	"soc_max" real,
	"batt_v_min" real,
	"batt_v_max" real,
	"source" text DEFAULT 'integrated' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_weather" (
	"date" date PRIMARY KEY NOT NULL,
	"weather_code" integer,
	"temp_max" real,
	"temp_min" real,
	"precip_mm" real,
	"radiation_kwh_m2" real,
	"forecast_pv_kwh" real,
	"actual_pv_kwh" real,
	"sunrise" text,
	"sunset" text
);
--> statement-breakpoint
CREATE TABLE "generator_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"runtime_s" integer,
	"energy_kwh" real DEFAULT 0 NOT NULL,
	"avg_w" integer
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"rule" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"read" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_s" integer,
	"min_soc" real
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"pv1_w" integer DEFAULT 0 NOT NULL,
	"pv2_w" integer DEFAULT 0 NOT NULL,
	"pv_w" integer DEFAULT 0 NOT NULL,
	"load_w" integer DEFAULT 0 NOT NULL,
	"grid_w" integer DEFAULT 0 NOT NULL,
	"batt_w" integer DEFAULT 0 NOT NULL,
	"batt_v" real,
	"batt_a" real,
	"soc" real,
	"grid_v" real,
	"grid_hz" real,
	"gen_w" integer DEFAULT 0 NOT NULL,
	"dc_temp" real,
	"heatsink_temp" real,
	"l1_w" integer,
	"l2_w" integer,
	"l3_w" integer,
	"l1_v" real,
	"l2_v" real,
	"l3_v" real
);
--> statement-breakpoint
CREATE INDEX "gen_started_idx" ON "generator_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "notifications_ts_idx" ON "notifications" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "outage_started_idx" ON "outage_events" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "telemetry_ts_brin" ON "telemetry" USING brin ("ts");