import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { createDb } from '../db/client';
import { users, whitelistEmails, visitorInstances, visitorTemplates, assistantStudents } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';

/**
 * 用法：
 * npx tsx src/main/rebindAssistantStudents.ts [assigned-output.csv]
 *
 * 行为：
 * - 清空 assistant_students 全量绑定
 * - 首选从 CSV 读取：
 *   - student 行：使用 assignedVisitor 作为唯一权威
 *   - assistant_tech 行：使用 inchargeVisitor 作为可负责的模板集合
 * - 若未提供 CSV，则退回读取 DB 的 whitelist_emails
 * - 为每个学生选择一个拥有该模板职责且当前最少绑定的技术助教，建立绑定
 * - 若学生目标模板实例不存在则自动创建
 * - 输出报告到 .reports/rebind-assistants-report.json
 */

function normalizeKey(v: any): string | null { const m = String(v ?? '').trim().match(/(\d{1,2})/); return m ? String(Number(m[1])) : null; }
function cleanEmail(e: string): string {
  return (e || '')
    .replace(/[\u2000-\u200B\u3000]/g, '') // 零宽/全角空白
    .replace(/\s+/g, '') // 去除普通空格（避免邮箱中间混入空格）
    .trim()
    .toLowerCase();
}

async function readCsv(filePath: string): Promise<any[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  return new Promise((resolve, reject) => {
    parse(content, { columns: true, trim: true, relaxQuotes: true, skipEmptyLines: true, bom: true }, (err, records: any[]) => {
      if (err) return reject(err);
      resolve(records);
    });
  });
}

async function main() {
  const csvFile = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const db = createDb();

  // 读取所有模板映射
  const tplRows = await db.select().from(visitorTemplates);
  const templateKeyToId = new Map<string, string>();
  for (const t of tplRows as any[]) templateKeyToId.set((t as any).templateKey, (t as any).id);

  let studentList: Array<{ email: string; assignedVisitor: string }>=[];
  let assistantMap: Map<string, string[]> = new Map(); // templateKey -> assistantIds[]

  if (csvFile) {
    const rows = await readCsv(csvFile);
    const students = rows.filter((r:any)=> String(r.role).trim()==='student');
    const tas = rows.filter((r:any)=> String(r.role).trim()==='assistant_tech');

    // 学生
    studentList = students.map((r:any)=> ({ email: cleanEmail(r.email), assignedVisitor: normalizeKey(r.assignedVisitor)||'' })).filter(s=>!!s.email && !!s.assignedVisitor);

    // 助教 inchargeVisitor
    const taEmails = tas.map((r:any)=> cleanEmail(r.email)).filter(Boolean);
    const taUsers = taEmails.length ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.email as any, taEmails as any)) : [];
    const taEmailToId = new Map<string,string>((taUsers as any[]).map(u=>[(u as any).email,(u as any).id]));

    assistantMap = new Map();
    for (const r of tas) {
      const email = cleanEmail(r.email);
      const id = taEmailToId.get(email);
      if (!id) continue;
      let keys: string[] = [];
      try { keys = r.inchargeVisitor ? (typeof r.inchargeVisitor==='string' ? JSON.parse(r.inchargeVisitor) : r.inchargeVisitor) : []; } catch {}
      keys.map((k:any)=> String(k)).forEach((k:string)=>{
        if (!assistantMap.has(k)) assistantMap.set(k, []);
        assistantMap.get(k)!.push(id);
      });
    }
  } else {
    // 回退 DB 白名单
    const taWhite = await db.select().from(whitelistEmails).where(eq(whitelistEmails.role as any, 'assistant_tech' as any));
    const taEmails = (taWhite as any[]).map(w => (w as any).email).filter(Boolean);
    const taUsers = taEmails.length ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.email as any, taEmails as any)) : [];
    const taEmailToId = new Map<string, string>((taUsers as any[]).map(u => [(u as any).email, (u as any).id]));
    assistantMap = new Map();
    for (const w of taWhite as any[]) {
      const keys: string[] = Array.isArray((w as any).inchargeVisitor) ? (w as any).inchargeVisitor.map((x: any)=> String(x)) : [];
      const taId = taEmailToId.get((w as any).email);
      if (!taId || keys.length === 0) continue;
      for (const k of keys) { if (!assistantMap.has(k)) assistantMap.set(k, []); assistantMap.get(k)!.push(taId); }
    }

    const stuWhite = await db.select().from(whitelistEmails).where(eq(whitelistEmails.role as any, 'student' as any));
    studentList = (stuWhite as any[]).map((s:any)=>({ email: cleanEmail((s as any).email), assignedVisitor: normalizeKey((s as any).assignedVisitor)||'' })).filter(s=>!!s.email && !!s.assignedVisitor);
  }

  // 学生 users 映射
  const stuEmails = studentList.map(s=>s.email);
  const stuUsers = stuEmails.length ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.email as any, stuEmails as any)) : [];
  const stuEmailToId = new Map<string,string>((stuUsers as any[]).map(u=>[(u as any).email,(u as any).id]));

  // 清空旧绑定
  try { await (db as any).delete(assistantStudents); } catch {}

  // 计数：助教当前绑定数（用于平衡）
  const assistantLoad = new Map<string, number>();
  for (const ids of assistantMap.values()) for (const id of ids) assistantLoad.set(id, assistantLoad.get(id)||0);

  const report:any = { source: csvFile ? 'csv' : 'db', totalStudents: studentList.length, assigned: 0, skippedNoStudentUser: 0, skippedNoTemplate: 0, skippedNoAssistantForKey: 0, items: [], loadByAssistant: [] };

  for (const s of studentList) {
    const studentId = stuEmailToId.get(s.email);
    if (!studentId) { report.skippedNoStudentUser++; report.items.push({ studentEmail: s.email, templateKey: s.assignedVisitor, reason: 'no_student_user' }); continue; }

    const k = s.assignedVisitor;
    const taIds = assistantMap.get(k) || [];
    if (taIds.length === 0) { report.skippedNoAssistantForKey++; report.items.push({ studentEmail: s.email, templateKey: k, reason: 'no_ta_for_template' }); continue; }

    const tplId = templateKeyToId.get(k);
    if (!tplId) { report.skippedNoTemplate++; report.items.push({ studentEmail: s.email, templateKey: k, reason: 'template_not_found' }); continue; }

    const instRows = await db.select({ id: visitorInstances.id, templateId: visitorInstances.templateId }).from(visitorInstances).where(eq(visitorInstances.userId as any, studentId));
    let targetInstanceId = (instRows as any[]).find(iv => String((iv as any).templateId) === tplId)?.id as string | undefined;
    if (!targetInstanceId) {
      const id = crypto.randomUUID();
      await db.insert(visitorInstances).values({ id, userId: studentId, templateId: tplId, longTermMemory: { thisweek_focus: '无', discussed_topics: '无', milestones: '无', recurring_patterns: '无', core_belief_evolution: '无' } as any, createdAt: new Date(), updatedAt: new Date() } as any);
      targetInstanceId = id;
    }

    // 选择负载最小的助教
    let chosenId = taIds[0];
    let minLoad = assistantLoad.get(chosenId) ?? 0;
    for (const taId of taIds) {
      const l = assistantLoad.get(taId) ?? 0;
      if (l < minLoad || (l === minLoad && taId < chosenId)) { chosenId = taId; minLoad = l; }
    }
    await db.insert(assistantStudents).values({ id: crypto.randomUUID(), assistantId: chosenId, studentId, visitorInstanceId: targetInstanceId!, createdAt: new Date() } as any);
    assistantLoad.set(chosenId, (assistantLoad.get(chosenId) || 0) + 1);
    report.assigned += 1;
    report.items.push({ studentEmail: s.email, templateKey: k, assistantId: chosenId, visitorInstanceId: targetInstanceId });
  }

  report.loadByAssistant = Array.from(assistantLoad.entries()).map(([assistantId, count]) => ({ assistantId, count })).sort((a,b)=> b.count - a.count);
  const out = path.resolve('.reports/rebind-assistants-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('Rebind completed:', JSON.stringify({ source: report.source, assigned: report.assigned, total: report.totalStudents, skipped: report.totalStudents - report.assigned }, null, 2));
}

main().catch((e)=>{ console.error(e); process.exit(1); });
