ALTER TABLE "appointments" ADD CONSTRAINT "appointments_id_client_id_owner_id_unique" UNIQUE("id","client_id","owner_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_client_fk" FOREIGN KEY ("appointment_id","client_id","owner_id") REFERENCES "public"."appointments"("id","client_id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_ends_after_start" CHECK ("appointments"."ends_at" > "appointments"."starts_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_price_nonnegative" CHECK ("appointments"."price" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_price_positive" CHECK ("services"."price" > 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_duration_positive" CHECK ("services"."duration_minutes" > 0);