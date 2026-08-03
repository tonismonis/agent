DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE "crm_app";
  END IF;
END $$;--> statement-breakpoint
ALTER ROLE "crm_app" WITH LOGIN PASSWORD 'crm_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"profession" text NOT NULL,
	"restricted_notes" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owners_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "owners_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "working_hours" (
	"owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	CONSTRAINT "working_hours_weekday_check" CHECK ("working_hours"."weekday" between 0 and 6),
	CONSTRAINT "working_hours_time_check" CHECK ("working_hours"."start_time" < "working_hours"."end_time")
);
--> statement-breakpoint
ALTER TABLE "working_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_appointment_id_appointments_id_fk";
--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "ts" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entity" text NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entity_id" integer;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "before" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_id_owner_id_unique" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_id_owner_id_unique" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_id_owner_id_unique" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_id_owner_id_unique" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_owner_fk" FOREIGN KEY ("client_id","owner_id") REFERENCES "public"."clients"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_owner_fk" FOREIGN KEY ("service_id","owner_id") REFERENCES "public"."services"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_owner_fk" FOREIGN KEY ("client_id","owner_id") REFERENCES "public"."clients"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_owner_fk" FOREIGN KEY ("appointment_id","owner_id") REFERENCES "public"."appointments"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "appointments" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_select" ON "audit_log" AS PERMISSIVE FOR SELECT TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_insert" ON "audit_log" AS PERMISSIVE FOR INSERT TO "crm_app" WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "clients" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "payments" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "services" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "working_hours" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_no_overlap" EXCLUDE USING gist (
  "owner_id" WITH =,
  "weekday" WITH =,
  int4range(extract(epoch FROM "start_time")::integer, extract(epoch FROM "end_time")::integer, '[)') WITH &&
);--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO crm_app', current_database());
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "crm_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clients", "services", "appointments", "payments", "working_hours" TO "crm_app";--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO "crm_app";--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "crm_app";