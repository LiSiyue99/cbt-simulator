CREATE TABLE "assistant_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sender_role" varchar(32) NOT NULL,
	"sender_id" text NOT NULL,
	"content" text NOT NULL,
	"status" varchar(16) DEFAULT 'unread' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_persona_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"editor_id" text NOT NULL,
	"editor_email" varchar(320) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "visitor_instances_demo_idx";--> statement-breakpoint
ALTER TABLE "visitor_templates" ALTER COLUMN "core_persona" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_persona_versions" ADD CONSTRAINT "core_persona_versions_template_id_visitor_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."visitor_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_persona_versions" ADD CONSTRAINT "core_persona_versions_editor_id_users_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_chat_messages_session_idx" ON "assistant_chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "assistant_chat_messages_sender_idx" ON "assistant_chat_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "assistant_chat_messages_status_idx" ON "assistant_chat_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "core_persona_versions_tpl_idx" ON "core_persona_versions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "core_persona_versions_editor_idx" ON "core_persona_versions" USING btree ("editor_id");--> statement-breakpoint
ALTER TABLE "visitor_instances" DROP COLUMN "is_demo";