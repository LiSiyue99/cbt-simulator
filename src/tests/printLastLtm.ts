import { createDb } from '../db/client';
import { visitorInstances } from '../db/schema';
import { desc } from 'drizzle-orm';

async function run() {
  const db = createDb();
  const rows = await db.select().from(visitorInstances).orderBy(desc(visitorInstances.createdAt as any)).limit(1);
  const ins = rows[0];
  if (!ins) {
    console.log('No instance found');
    return;
  }
  console.log('VisitorInstanceId:', ins.id);
  console.log('LongTermMemory:', JSON.stringify(ins.longTermMemory, null, 2));
}

run().catch((e) => { console.error(e); process.exit(1); });


