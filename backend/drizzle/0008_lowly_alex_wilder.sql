CREATE TABLE "ip_geo" (
	"ip" text PRIMARY KEY NOT NULL,
	"lat" real,
	"lon" real,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"environment_id" uuid,
	"user_id" integer,
	"ip" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "visits_ts_idx" ON "visits" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "visits_session_idx" ON "visits" USING btree ("session_id");