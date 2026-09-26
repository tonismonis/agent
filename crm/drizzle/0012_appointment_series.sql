CREATE TABLE "appointment_series" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL,
	"client_id" integer NOT NULL,
	"service_id" integer NOT NULL,
	"mode" "appointment_mode" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"price" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "appointment_series_id_owner_id_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "appointment_series_id_client_id_owner_id_unique" UNIQUE("id","client_id","owner_id"),
	CONSTRAINT "appointment_series_ends_on_or_after_start" CHECK ("appointment_series"."ends_on" >= "appointment_series"."starts_on"),
	CONSTRAINT "appointment_series_duration_positive" CHECK ("appointment_series"."duration_minutes" > 0),
	CONSTRAINT "appointment_series_price_nonnegative" CHECK ("appointment_series"."price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "appointment_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointment_series_days" (
	"series_id" integer NOT NULL,
	"owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL,
	"weekday" integer NOT NULL,
	"starts_time" time NOT NULL,
	CONSTRAINT "appointment_series_days_series_id_weekday_pk" PRIMARY KEY("series_id","weekday"),
	CONSTRAINT "appointment_series_days_weekday_range" CHECK ("appointment_series_days"."weekday" between 0 and 6)
);
--> statement-breakpoint
ALTER TABLE "appointment_series_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_id" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_date" date;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_weekday" integer GENERATED ALWAYS AS (extract(dow from "series_date")::int) STORED;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_client_owner_fk" FOREIGN KEY ("client_id","owner_id") REFERENCES "public"."clients"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_service_owner_fk" FOREIGN KEY ("service_id","owner_id") REFERENCES "public"."services"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series_days" ADD CONSTRAINT "appointment_series_days_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series_days" ADD CONSTRAINT "appointment_series_days_series_owner_fk" FOREIGN KEY ("series_id","owner_id") REFERENCES "public"."appointment_series"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_client_fk" FOREIGN KEY ("series_id","client_id","owner_id") REFERENCES "public"."appointment_series"("id","client_id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_day_fk" FOREIGN KEY ("series_id","series_weekday") REFERENCES "public"."appointment_series_days"("series_id","weekday") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_series_date_unique" ON "appointments" USING btree ("series_id","series_date") WHERE "appointments"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_pair" CHECK (("appointments"."series_id" is null) = ("appointments"."series_date" is null));--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "appointment_series" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "appointment_series_days" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "appointment_series", "appointment_series_days" TO "crm_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "appointment_series_id_seq" TO "crm_app";
