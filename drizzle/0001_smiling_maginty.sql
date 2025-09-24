CREATE TABLE "long_term_memory_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"visitor_instance_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "assigned_homework" TO "homework";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pre_session_activity" jsonb;--> statement-breakpoint
ALTER TABLE "visitor_templates" ADD COLUMN "core_persona" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "visitor_templates" ADD COLUMN "chat_principle" text NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memory_versions" ADD CONSTRAINT "long_term_memory_versions_visitor_instance_id_visitor_instances_id_fk" FOREIGN KEY ("visitor_instance_id") REFERENCES "public"."visitor_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "weekly_activity_report";--> statement-breakpoint
ALTER TABLE "visitor_instances" DROP COLUMN "core_persona";