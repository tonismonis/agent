CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"ts" timestamp with time zone DEFAULT now()
);
