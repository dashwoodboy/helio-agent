CREATE TABLE "inverter_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inverter_profiles" ADD CONSTRAINT "inverter_profiles_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inverter_profiles_env_name_idx" ON "inverter_profiles" USING btree ("environment_id","name");