CREATE TABLE "messages" (
	"owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL,
	"thread_id" text NOT NULL,
	"messages_json" jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "messages_owner_id_thread_id_pk" PRIMARY KEY("owner_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "runs" (
	"owner_id" uuid DEFAULT nullif(current_setting('app.owner_id', true), '')::uuid NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"error" text,
	"usage_json" jsonb,
	CONSTRAINT "runs_owner_id_run_id_pk" PRIMARY KEY("owner_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_owner_started_at_idx" ON "runs" USING btree ("owner_id","started_at");--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "messages" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
CREATE POLICY "owner_isolation" ON "runs" AS PERMISSIVE FOR ALL TO "crm_app" USING (owner_id = current_setting('app.owner_id')::uuid) WITH CHECK (owner_id = current_setting('app.owner_id')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "messages", "runs" TO "crm_app";