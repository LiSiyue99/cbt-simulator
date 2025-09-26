CREATE TABLE "weekly_compliance" (
	"id" text PRIMARY KEY NOT NULL,
	"week_key" varchar(16) NOT NULL,
	"class_id" bigint NOT NULL,
	"student_id" text NOT NULL,
	"assistant_id" text,
	"has_session" integer DEFAULT 0 NOT NULL,
	"has_thought_record_by_fri" integer DEFAULT 0 NOT NULL,
	"has_any_feedback_by_sun" integer DEFAULT 0 NOT NULL,
	"locked" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "finalized_at" timestamp;--> statement-breakpoint
ALTER TABLE "weekly_compliance" ADD CONSTRAINT "weekly_compliance_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_compliance" ADD CONSTRAINT "weekly_compliance_assistant_id_users_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_compliance_week_class_idx" ON "weekly_compliance" USING btree ("week_key","class_id");--> statement-breakpoint
CREATE INDEX "weekly_compliance_student_week_idx" ON "weekly_compliance" USING btree ("student_id","week_key");