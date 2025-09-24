CREATE TABLE "assistant_students" (
	"id" text PRIMARY KEY NOT NULL,
	"assistant_id" text NOT NULL,
	"student_id" text NOT NULL,
	"visitor_instance_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" varchar(32) DEFAULT 'student' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_students" ADD CONSTRAINT "assistant_students_assistant_id_users_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_students" ADD CONSTRAINT "assistant_students_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_students" ADD CONSTRAINT "assistant_students_visitor_instance_id_visitor_instances_id_fk" FOREIGN KEY ("visitor_instance_id") REFERENCES "public"."visitor_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_students_uq" ON "assistant_students" USING btree ("assistant_id","student_id","visitor_instance_id");--> statement-breakpoint
CREATE INDEX "assistant_students_assistant_idx" ON "assistant_students" USING btree ("assistant_id");--> statement-breakpoint
CREATE INDEX "assistant_students_student_idx" ON "assistant_students" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "assistant_students_instance_idx" ON "assistant_students" USING btree ("visitor_instance_id");