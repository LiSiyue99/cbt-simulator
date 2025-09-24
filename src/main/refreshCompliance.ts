import 'dotenv/config';
import { createDb } from '../db/client';
import { users } from '../db/schema';
import { formatWeekKey, getBeijingNow } from '../policy/timeWindow';
import { computeClassWeekCompliance } from '../services/compliance';
import { eq } from 'drizzle-orm';

async function main() {
  const db = createDb();
  const now = getBeijingNow();
  const week = formatWeekKey(now);

  const classRows = await db
    .select({ classId: users.classId })
    .from(users)
    .where(eq(users.role as any, 'assistant_class'));
  const classIds = Array.from(new Set((classRows as any[]).map(r => r.classId).filter(Boolean)));

  for (const cid of classIds) {
    await computeClassWeekCompliance(cid as number, week);
    console.log(`Computed compliance for class ${cid} week ${week}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
