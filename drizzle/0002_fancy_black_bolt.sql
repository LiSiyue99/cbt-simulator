ALTER TABLE "thought_records" DROP CONSTRAINT "thought_records_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "visitor_templates" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_instance_number_uq" ON "sessions" USING btree ("visitor_instance_id","session_number");--> statement-breakpoint
CREATE INDEX "sessions_visitor_idx" ON "sessions" USING btree ("visitor_instance_id");--> statement-breakpoint
CREATE INDEX "thought_records_session_idx" ON "thought_records" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visitor_instances_user_template_uq" ON "visitor_instances" USING btree ("user_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visitor_templates_name_uq" ON "visitor_templates" USING btree ("name");--> statement-breakpoint
ALTER TABLE "thought_records" DROP COLUMN "user_id";