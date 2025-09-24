import { createDb } from '../db/client';
import { users, visitorTemplates, visitorInstances } from '../db/schema';

async function run() {
  const db = createDb();
  // 1) user
  const userId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `demo_${Date.now()}@example.com`, createdAt: new Date(), updatedAt: new Date() });

  // 2) template (use templateKey "1")
  const templateId = crypto.randomUUID();
  await db.insert(visitorTemplates).values({
    id: templateId,
    templateKey: '1',
    name: '1',
    brief: 'demo template',
    corePersona: {},
    chatPrinciple: 'see prompts/chat_principle.txt',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);

  // 3) instance
  const instanceId = crypto.randomUUID();
  await db.insert(visitorInstances).values({
    id: instanceId,
    userId,
    templateId,
    longTermMemory: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);

  console.log(`DEMO_VISITOR_INSTANCE_ID=${instanceId}`);
}

run().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});


