CREATE TABLE "assistant_feedbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"content" text NOT NULL,
	"status" varchar(32) DEFAULT 'published' NOT NULL,
	"due_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"student_id" text NOT NULL,
	"content" text NOT NULL,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"due_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"email" varchar(256) NOT NULL,
	"code" varchar(16) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whitelist_emails" (
	"email" varchar(256) PRIMARY KEY NOT NULL,
	"name" varchar(256),
	"user_id" bigint,
	"role" varchar(32) NOT NULL,
	"class_id" bigint,
	"assigned_tech_asst" varchar(64),
	"assigned_class_asst" varchar(64),
	"assigned_visitor" varchar(8),
	"incharge_visitor" jsonb,
	"student_count" integer DEFAULT 0,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "class_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" varchar(32) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_feedbacks" ADD CONSTRAINT "assistant_feedbacks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_feedbacks" ADD CONSTRAINT "assistant_feedbacks_assistant_id_users_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_feedbacks_session_idx" ON "assistant_feedbacks" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "assistant_feedbacks_assistant_idx" ON "assistant_feedbacks" USING btree ("assistant_id");--> statement-breakpoint
CREATE INDEX "questions_session_idx" ON "questions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "questions_student_idx" ON "questions" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "verification_codes_email_idx" ON "verification_codes" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "whitelist_user_id_uq" ON "whitelist_emails" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "whitelist_class_role_idx" ON "whitelist_emails" USING btree ("class_id","role");--> statement-breakpoint
CREATE INDEX "whitelist_assigned_tech_idx" ON "whitelist_emails" USING btree ("assigned_tech_asst");--> statement-breakpoint
CREATE INDEX "whitelist_assigned_class_idx" ON "whitelist_emails" USING btree ("assigned_class_asst");--> statement-breakpoint
CREATE INDEX "whitelist_assigned_visitor_idx" ON "whitelist_emails" USING btree ("assigned_visitor");--> statement-breakpoint
CREATE INDEX "whitelist_role_status_idx" ON "whitelist_emails" USING btree ("role","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_user_id_uq" ON "users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_class_role_idx" ON "users" USING btree ("class_id","role");--> statement-breakpoint
CREATE INDEX "users_role_status_idx" ON "users" USING btree ("role","status");