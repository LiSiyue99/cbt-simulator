import 'dotenv/config';
import { createDb } from '../db/client';
import { users, visitorTemplates, visitorInstances } from '../db/schema';
import { eq } from 'drizzle-orm';

/**
 * 为所有助教（assistant_tech）与非学生行政助教（assistant_class 且无 student 主身份）
 * 生成 10 个模板的 playground 实例（幂等）。
 * 用法：tsx src/main/seedPlaygroundInstances.ts
 */
async function main() {
  const db = createDb();
  // 技术助教
  const techRows = await db.select().from(users).where(eq(users.role as any, 'assistant_tech'));
  // 行政助教（非学生主身份）
  const classRows = await db.select().from(users).where(eq(users.role as any, 'assistant_class'));
  const targetUsers = [...(techRows as any[]), ...(classRows as any[])];

  const templates = await db.select().from(visitorTemplates);
  for (const u of targetUsers as any[]) {
    const existing = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (u as any).id));
    const haveTpl = new Set((existing as any[]).map((v: any) => v.templateId));
    for (const t of templates as any[]) {
      if (!haveTpl.has((t as any).id)) {
        await db.insert(visitorInstances).values({
          id: crypto.randomUUID(),
          userId: (u as any).id,
          templateId: (t as any).id,
          longTermMemory: {
            thisweek_focus: '助教体验',
            discussed_topics: '—',
            milestones: '—',
            recurring_patterns: '—',
            core_belief_evolution: '—',
          } as any,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);
      }
    }
    console.log(`Playground ready for assistant ${u.email}`);
  }
  console.log('Seed completed.');
}

main().catch((e) => { console.error(e); process.exit(1); });


