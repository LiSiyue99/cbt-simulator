import { createDb } from '../db/client';

/**
 * 清空测试数据（不动 visitor_templates 等基础数据）。
 */
async function run() {
  const db = createDb();
  // 确保新表已存在（本地环境容错）
  await db.execute(`
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
  ` as any);
  await db.execute(`
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
  ` as any);
  // 依赖外键顺序：先子表 homework_submissions，再 long_term_memory_versions，最后 sessions
  await db.execute(
    `TRUNCATE TABLE homework_submissions, long_term_memory_versions, sessions RESTART IDENTITY CASCADE;`
  );
  console.log('Test tables truncated.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});


