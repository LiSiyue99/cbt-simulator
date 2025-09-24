import { createDb } from '../db/client';
import { visitorTemplates } from '../db/schema';
import { readTextFile } from '../utils/file';
import path from 'node:path';
import { eq } from 'drizzle-orm';

async function run() {
  const db = createDb();
  for (let i = 1; i <= 10; i++) {
    const key = String(i);
    const cpPath = path.join(process.cwd(), 'core_persona', `${key}.txt`);
    const corePersona = await readTextFile(cpPath);
    const name = key;
    const brief = `template ${key}`;
    const [exists] = await db.select().from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, key));
    if (exists) continue;
    await db.insert(visitorTemplates).values({
      id: crypto.randomUUID(),
      templateKey: key,
      name,
      brief,
      corePersona: corePersona as any,
      chatPrinciple: 'see prompts/chat_principle.txt',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    console.log(`seeded template ${key}`);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });


