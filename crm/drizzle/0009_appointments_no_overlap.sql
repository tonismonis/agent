-- Backstop for assertNoOverlap: two concurrent bookings both pass its check.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap" EXCLUDE USING gist (
	"owner_id" WITH =,
	tstzrange("starts_at", "ends_at") WITH &&
) WHERE ("status" = 'scheduled' AND "deleted_at" IS NULL);
