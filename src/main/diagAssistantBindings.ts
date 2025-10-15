import 'dotenv/config';
import { createDb } from '../db/client';
import { users, assistantStudents, visitorInstances, visitorTemplates } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';

function cleanEmail(e: string) {
  return (e || '')
    .replace(/[\u2000-\u200B\u3000]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

async function main(){
  const db = createDb();
  const emailArg = process.argv[2] ? cleanEmail(process.argv[2]) : null;

  // 所有技术助教
  const allUsers = await db.select().from(users);
  const assistants = (allUsers as any[]).filter(u => (u as any).role === 'assistant_tech');
  const focus = emailArg ? assistants.filter(a => cleanEmail((a as any).email) === emailArg) : assistants;

  const result:any[] = [];
  for (const a of focus as any[]) {
    const binds = await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, (a as any).id));
    const count = (binds as any[]).length;
    let samples:any[] = [];
    if (count){
      const sampleBinds = (binds as any[]).slice(0,5);
      const instanceIds = sampleBinds.map(b => (b as any).visitorInstanceId);
      const instRows = await db.select({ id: visitorInstances.id, userId: visitorInstances.userId, templateId: visitorInstances.templateId }).from(visitorInstances).where(inArray(visitorInstances.id as any, instanceIds as any));
      const tplIds = Array.from(new Set((instRows as any[]).map(r => (r as any).templateId)));
      const tplRows = tplIds.length ? await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey }).from(visitorTemplates).where(inArray(visitorTemplates.id as any, tplIds as any)) : [];
      const tplKeyById = new Map<string,string>((tplRows as any[]).map(t=>[(t as any).id,(t as any).templateKey]));
      for (const b of sampleBinds as any[]){
        const inst = (instRows as any[]).find(i => (i as any).id === (b as any).visitorInstanceId);
        const stu = (allUsers as any[]).find(u => (u as any).id === (b as any).studentId);
        samples.push({ studentEmail: (stu as any)?.email, templateKey: inst ? tplKeyById.get((inst as any).templateId) : null, visitorInstanceId: (b as any).visitorInstanceId });
      }
    }
    result.push({ assistantEmail: (a as any).email, assistantId: (a as any).id, bindingCount: count, samples });
  }

  console.log(JSON.stringify({ assistants: result, totalAssistants: result.length }, null, 2));
}

main().catch(e=>{ console.error(e); process.exit(1); });
