CREATE TABLE "inverter_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" integer,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"fields" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "inverter_changes" ADD CONSTRAINT "inverter_changes_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inverter_changes" ADD CONSTRAINT "inverter_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inverter_changes_env_ts_idx" ON "inverter_changes" USING btree ("environment_id","ts");