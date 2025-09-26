CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" text NOT NULL,
	"summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
