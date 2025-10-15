CREATE TABLE "deadline_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" varchar(16) NOT NULL,
	"subject_id" text NOT NULL,
	"week_key" varchar(16) NOT NULL,
	"action" varchar(32) NOT NULL,
	"until" timestamp NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "session_deadline_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"action" varchar(32) NOT NULL,
	"until" timestamp NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_configs" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE IF EXISTS "core_persona_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "deadline_overrides" ADD CONSTRAINT "deadline_overrides_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_overrides" ADD CONSTRAINT "deadline_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_deadline_overrides" ADD CONSTRAINT "session_deadline_overrides_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_deadline_overrides" ADD CONSTRAINT "session_deadline_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deadline_overrides_subject_week_idx" ON "deadline_overrides" USING btree ("subject_id","week_key");--> statement-breakpoint
CREATE INDEX "deadline_overrides_week_idx" ON "deadline_overrides" USING btree ("week_key");--> statement-breakpoint
CREATE INDEX "session_deadline_overrides_session_idx" ON "session_deadline_overrides" USING btree ("session_id");