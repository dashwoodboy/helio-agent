ALTER TABLE "daily_energy" ADD COLUMN "gen_to_batt_kwh" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_energy" ADD COLUMN "ac_pv_to_batt_kwh" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_energy" ADD COLUMN "import_slots_kwh" jsonb;