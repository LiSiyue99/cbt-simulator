import { createDb } from '../db/client';
import { users, visitorTemplates, visitorInstances } from '../db/schema';
import { eq } from 'drizzle-orm';

async function run() {
  const db = createDb();
  let [tpl] = await db.select().from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, '1')).limit(1);
  if (!tpl) throw new Error('templateKey=1 not found. Run seed:templates first.');
  const userId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `student_${Date.now()}@example.com`, name: '种子学生', role: 'student', classId: 1 as any, createdAt: new Date(), updatedAt: new Date() } as any);
  const instanceId = crypto.randomUUID();
  await db.insert(visitorInstances).values({ id: instanceId, userId, templateId: (tpl as any).id, longTermMemory: {}, createdAt: new Date(), updatedAt: new Date() } as any);
  console.log(instanceId);
}

run().catch((e) => { console.error(e); process.exit(1); });


