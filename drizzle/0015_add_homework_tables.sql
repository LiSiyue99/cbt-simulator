-- Create homework tables and drop legacy thought_records

CREATE TABLE IF NOT EXISTS "homework_sets" (
  "id" text PRIMARY KEY NOT NULL,
  "class_id" bigint NOT NULL,
  "title" varchar(256),
  "description" text,
  "sequence_number" integer NOT NULL,
  "form_fields" jsonb NOT NULL,
  "student_start_at" timestamp NOT NULL,
  "student_deadline" timestamp NOT NULL,
  "assistant_start_at" timestamp NOT NULL,
  "assistant_deadline" timestamp NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'published',
  "created_by" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "homework_sets_class_seq_uq" ON "homework_sets" ("class_id", "sequence_number");
CREATE INDEX IF NOT EXISTS "homework_sets_class_idx" ON "homework_sets" ("class_id");

ALTER TABLE "homework_sets" ADD CONSTRAINT IF NOT EXISTS "homework_sets_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE IF NOT EXISTS "homework_submissions" (
  "id" text PRIMARY KEY NOT NULL,
  "homework_set_id" text NOT NULL,
  "session_id" text NOT NULL,
  "student_id" text NOT NULL,
  "form_data" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "homework_submissions_session_uq" ON "homework_submissions" ("session_id");
CREATE INDEX IF NOT EXISTS "homework_submissions_set_idx" ON "homework_submissions" ("homework_set_id");
CREATE INDEX IF NOT EXISTS "homework_submissions_student_idx" ON "homework_submissions" ("student_id");

ALTER TABLE "homework_submissions" ADD CONSTRAINT IF NOT EXISTS "homework_submissions_set_fk"
  FOREIGN KEY ("homework_set_id") REFERENCES "public"."homework_sets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "homework_submissions" ADD CONSTRAINT IF NOT EXISTS "homework_submissions_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "homework_submissions" ADD CONSTRAINT IF NOT EXISTS "homework_submissions_student_fk"
  FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Drop legacy table if exists
DROP TABLE IF EXISTS "thought_records";


