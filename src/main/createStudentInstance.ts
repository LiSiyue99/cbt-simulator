import 'dotenv/config';
import { createDb } from '../db/client';
import { users, visitorInstances, visitorTemplates } from '../db/schema';
import { eq } from 'drizzle-orm';

function cleanEmail(e: string): string { return (e||'').replace(/[\u2000-\u200B\u3000]/g,'').trim().toLowerCase(); }
function normKey(v: any): string { const m = String(v||'').trim().match(/(\d{1,2})/); if (!m) throw new Error('bad templateKey'); return String(Number(m[1])); }

// SAFETY GUARD: disabled by default to avoid accidental runs
if (process.env.ALLOW_DANGEROUS_SCRIPTS !== 'true') {
  console.error('Disabled: set ALLOW_DANGEROUS_SCRIPTS=true to run createStudentInstance');
  process.exit(1);
}

async function main() {
  const rawEmail = process.argv[2];
  const rawKey = process.argv[3];
  if (!rawEmail || !rawKey) throw new Error('Usage: tsx src/main/createStudentInstance.ts <email> <templateKey 1..10>');
  const email = cleanEmail(rawEmail);
  const templateKey = normKey(rawKey);

  const db = createDb();
  const [u] = await db.select().from(users).where(eq(users.email as any, email));
  if (!u) throw new Error('student not found: ' + email);

  const existing = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (u as any).id));
  if ((existing as any[]).length > 0) return console.log('already has instance(s), skip');

  const [tpl] = await db.select().from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, templateKey));
  if (!tpl) throw new Error('template not found: ' + templateKey);

  const id = crypto.randomUUID();
  await db.insert(visitorInstances).values({
    id,
    userId: (u as any).id,
    templateId: (tpl as any).id,
    longTermMemory: {
      thisweek_focus: '无',
      discussed_topics: '无',
      milestones: '无',
      recurring_patterns: '无',
      core_belief_evolution: '无',
    } as any,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
  console.log('created instance', { email, templateKey, instanceId: id });
}

main().catch((e)=>{ console.error(e); process.exit(1); });
