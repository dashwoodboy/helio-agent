CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"lat" real DEFAULT 0 NOT NULL,
	"lon" real DEFAULT 0 NOT NULL,
	"source_type" text DEFAULT 'gateway' NOT NULL,
	"logger_serial" bigint,
	"logger_last_seen_at" timestamp with time zone,
	"inverter_ip" text,
	"inverter_port" integer,
	"inverter_config" jsonb,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" integer NOT NULL,
	"environment_id" uuid NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_environment_id_pk" PRIMARY KEY("user_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"firebase_uid" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "gen_started_idx";--> statement-breakpoint
DROP INDEX "notifications_ts_idx";--> statement-breakpoint
DROP INDEX "outage_started_idx";--> statement-breakpoint
DROP INDEX "telemetry_ts_brin";--> statement-breakpoint
ALTER TABLE "daily_energy" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_weather" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "generator_sessions" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "outage_events" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "telemetry" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
INSERT INTO "environments" ("id", "name", "timezone", "source_type")
SELECT '00000000-0000-0000-0000-000000000001', 'My environment', 'UTC', 'direct'
WHERE EXISTS (SELECT 1 FROM "daily_energy" LIMIT 1)
   OR EXISTS (SELECT 1 FROM "telemetry" LIMIT 1)
   OR EXISTS (SELECT 1 FROM "settings" LIMIT 1)
   OR EXISTS (SELECT 1 FROM "notifications" LIMIT 1)
   OR EXISTS (SELECT 1 FROM "daily_weather" LIMIT 1)
   OR EXISTS (SELECT 1 FROM "outage_events" LIMIT 1)
   OR EXISTS (SELECT 1 FROM "generator_sessions" LIMIT 1);--> statement-breakpoint
UPDATE "daily_energy" SET "environment_id" = '00000000-0000-0000-0000-000000000001' WHERE "environment_id" IS NULL;--> statement-breakpoint
UPDATE "daily_weather" SET "environment_id" = '00000000-0000-0000-0000-000000000001' WHERE "environment_id" IS NULL;--> statement-breakpoint
UPDATE "generator_sessions" SET "environment_id" = '00000000-0000-0000-0000-000000000001' WHERE "environment_id" IS NULL;--> statement-breakpoint
UPDATE "notifications" SET "environment_id" = '00000000-0000-0000-0000-000000000001' WHERE "environment_id" IS NULL;--> statement-breakpoint
UPDATE "outage_events" SET "environment_id" = '00000000-0000-0000-0000-000000000001' WHERE "environment_id" IS NULL;--> statement-breakpoint
UPDATE "settings" SET "environment_id" = '00000000-0000-0000-0000-000000000001' WHERE "environment_id" IS NULL;--> statement-breakpoint
UPDATE "telemetry" SET "environment_id" = '00000000-0000-0000-0000-000000000001' WHERE "environment_id" IS NULL;--> statement-breakpoint
ALTER TABLE "daily_energy" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_weather" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generator_sessions" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "outage_events" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_energy" DROP CONSTRAINT "daily_energy_pkey";--> statement-breakpoint
ALTER TABLE "daily_weather" DROP CONSTRAINT "daily_weather_pkey";--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey";--> statement-breakpoint
ALTER TABLE "daily_energy" ADD CONSTRAINT "daily_energy_environment_id_date_pk" PRIMARY KEY("environment_id","date");--> statement-breakpoint
ALTER TABLE "daily_weather" ADD CONSTRAINT "daily_weather_environment_id_date_pk" PRIMARY KEY("environment_id","date");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_environment_id_key_pk" PRIMARY KEY("environment_id","key");--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_logger_serial_idx" ON "environments" USING btree ("logger_serial");--> statement-breakpoint
CREATE INDEX "memberships_env_idx" ON "memberships" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_firebase_uid_idx" ON "users" USING btree ("firebase_uid");--> statement-breakpoint
ALTER TABLE "daily_energy" ADD CONSTRAINT "daily_energy_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_weather" ADD CONSTRAINT "daily_weather_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generator_sessions" ADD CONSTRAINT "generator_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage_events" ADD CONSTRAINT "outage_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gen_env_started_idx" ON "generator_sessions" USING btree ("environment_id","started_at");--> statement-breakpoint
CREATE INDEX "notifications_env_ts_idx" ON "notifications" USING btree ("environment_id","ts");--> statement-breakpoint
CREATE INDEX "outage_env_started_idx" ON "outage_events" USING btree ("environment_id","started_at");--> statement-breakpoint
CREATE INDEX "telemetry_env_ts_idx" ON "telemetry" USING btree ("environment_id","ts");
