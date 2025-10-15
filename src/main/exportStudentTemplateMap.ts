import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../db/client';
import { users, visitorInstances, visitorTemplates } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';

/**
 * 导出每位学生的所有实例及其模板Key
 * 生成：.reports/student-template-map.json 和 .reports/student-template-map.csv
 */
async function main() {
  const db = createDb();
  const reportsDir = path.resolve('.reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const studentRows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.role as any, 'student' as any));
  const studentIds = (studentRows as any[]).map(s => (s as any).id);

  const instanceRows = studentIds.length
    ? await db.select({ id: visitorInstances.id, userId: visitorInstances.userId, templateId: visitorInstances.templateId }).from(visitorInstances).where(inArray(visitorInstances.userId as any, studentIds as any))
    : [];
  const templateIds = Array.from(new Set((instanceRows as any[]).map(r => (r as any).templateId)));
  const templates = templateIds.length
    ? await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey, name: visitorTemplates.name }).from(visitorTemplates).where(inArray(visitorTemplates.id as any, templateIds as any))
    : [];
  const templateKeyById = new Map<string, string>((templates as any[]).map(t => [(t as any).id, (t as any).templateKey]));

  // 聚合
  const byStudent: Record<string, { name: string|null; email: string; templates: string[] }> = {};
  for (const s of studentRows as any[]) {
    byStudent[(s as any).id] = { name: (s as any).name || null, email: (s as any).email, templates: [] };
  }
  for (const inst of instanceRows as any[]) {
    const sid = (inst as any).userId as string;
    const tplKey = templateKeyById.get((inst as any).templateId) || '';
    if (!tplKey) continue;
    byStudent[sid]?.templates.push(tplKey);
  }

  // 输出 JSON
  const jsonItems = Object.entries(byStudent).map(([id, v]) => ({ studentId: id, name: v.name, email: v.email, templateKeys: Array.from(new Set(v.templates)).sort((a,b)=> Number(a)-Number(b)) }));
  fs.writeFileSync(path.join(reportsDir, 'student-template-map.json'), JSON.stringify({ items: jsonItems }, null, 2));

  // 输出 CSV
  const csvHeader = 'name,email,templateKeys\n';
  const csvBody = jsonItems.map(it => `${(it.name||'')},${it.email},"${it.templateKeys.join(' ')}"`).join('\n');
  fs.writeFileSync(path.join(reportsDir, 'student-template-map.csv'), csvHeader + csvBody + '\n');

  console.log('Exported:', path.join(reportsDir, 'student-template-map.json'));
  console.log('Exported:', path.join(reportsDir, 'student-template-map.csv'));
}

main().catch((e)=>{ console.error(e); process.exit(1); });
