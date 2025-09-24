import { createDb } from '../db/client';

/**
 * 清空测试数据（不动 visitor_templates 等基础数据）。
 */
async function run() {
  const db = createDb();
  // 依赖外键顺序：先子表 thought_records，再 long_term_memory_versions，最后 sessions
  await db.execute(
    // @ts-expect-error drizzle node-postgres execute 原样透传
    `TRUNCATE TABLE thought_records, long_term_memory_versions, sessions RESTART IDENTITY CASCADE;`
  );
  console.log('Test tables truncated.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});


