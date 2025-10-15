import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { createDb } from '../db/client';
import { users, whitelistEmails, visitorTemplates, visitorInstances, assistantStudents } from '../db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';

/**
 * 读取 CSV 并解析为记录数组
 */
async function readCsv(filePath: string): Promise<any[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  return new Promise((resolve, reject) => {
    parse(content, { columns: true, trim: true, relaxQuotes: true, skipEmptyLines: true, bom: true }, (err, records: any[]) => {
      if (err) return reject(err);
      resolve(records);
    });
  });
}

/**
 * 将模板 key 规范化为 '1'..'10' 的字符串
 */
function normalizeTemplateKey(t: string | number | undefined | null): string | null {
  if (t === undefined || t === null) return null;
  const s = String(t).trim();
  const m = s.match(/(\d{1,2})/);
  if (!m) return null;
  return String(Number(m[1]));
}

/**
 * 将 assignedTechAsst（邮箱或工号）解析为 users.id
 */
async function resolveAssistantId(db: any, value: string | undefined | null): Promise<string | null> {
  if (!value) return null;
  const lookup = String(value).trim();
  if (!lookup) return null;
  if (lookup.includes('@')) {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email as any, lookup));
    return (rows as any[])[0]?.id || null;
  }
  // 尝试按 userId（业务号）匹配；否则回退邮箱再试
  const byUid = await db.select({ id: users.id }).from(users).where(eq(users.userId as any, lookup as any));
  if ((byUid as any[]).length) return (byUid as any[])[0].id;
  const byEmail = await db.select({ id: users.id }).from(users).where(eq(users.email as any, lookup));
  return (byEmail as any[])[0]?.id || null;
}

/**
 * 主流程：按 CSV 对齐学生实例与助教绑定，并生成报告
 */
async function main() {
  const csvFile = process.argv[2] || path.resolve(process.cwd(), 'assigned-output.csv');
  const rows = await readCsv(csvFile);
  const db = createDb();

  // 预取模板映射
  const tplRows = await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey }).from(visitorTemplates);
  const keyToTemplateId = new Map<string, string>();
  const templateIdToKey = new Map<string, string>();
  for (const t of tplRows as any[]) {
    keyToTemplateId.set((t as any).templateKey, (t as any).id);
    templateIdToKey.set((t as any).id, (t as any).templateKey);
  }

  // 预取所有用户，构建 email → id、role 映射
  const allUsers = await db.select().from(users);
  const emailToUser = new Map<string, any>();
  for (const u of allUsers as any[]) emailToUser.set((u as any).email, u);

  const students = rows.filter(r => String(r.role).trim() === 'student');
  const assistants = rows.filter(r => String(r.role).trim() === 'assistant_tech');

  // 助教 inchargeVisitor 映射（仅用于报告校验）
  const assistantEmailToIncharge: Record<string, string[]> = {};
  for (const a of assistants) {
    try {
      const parsed = a.inchargeVisitor ? (typeof a.inchargeVisitor === 'string' ? JSON.parse(a.inchargeVisitor) : a.inchargeVisitor) : [];
      assistantEmailToIncharge[a.email] = Array.isArray(parsed) ? parsed.map((x: any) => String(x)) : [];
    } catch {
      assistantEmailToIncharge[a.email] = [];
    }
  }

  const report = {
    createdInstances: 0,
    createdBindings: 0,
    extraInstances: [] as Array<{ studentEmail: string; instanceId: string; templateKey: string }>,
    wrongBindings: [] as Array<{ studentEmail: string; assistantId: string; visitorInstanceId: string; reason: string }>,
    missingAssistantUser: [] as Array<{ studentEmail: string; assignedTechAsst: string }>,
    assistantScopeMismatch: [] as Array<{ assistantEmail: string; studentEmail: string; templateKey: string }>,
  };

  for (const s of students) {
    const studentEmail = String(s.email).trim().toLowerCase();
    const student = emailToUser.get(studentEmail);
    if (!student) continue; // 用户不存在则跳过

    const desiredTplKey = normalizeTemplateKey(s.assignedVisitor) || '1';
    const desiredTplId = keyToTemplateId.get(desiredTplKey);
    if (!desiredTplId) throw new Error(`模板 ${desiredTplKey} 未找到，请先初始化 visitor_templates`);

    // 拉取该学生的所有实例
    const instRows = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (student as any).id));
    const hasDesired = (instRows as any[]).find(r => String((r as any).templateId) === String(desiredTplId));

    let targetInstanceId: string | null = hasDesired ? (hasDesired as any).id : null;
    if (!hasDesired) {
      // 创建目标模板实例
      const id = crypto.randomUUID();
      await db.insert(visitorInstances).values({
        id,
        userId: (student as any).id,
        templateId: desiredTplId,
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
      report.createdInstances += 1;
      targetInstanceId = id;
    }

    // 记录多余实例（保守策略：仅报告，不删除）
    for (const r of instRows as any[]) {
      const tplKey = templateIdToKey.get((r as any).templateId) || '';
      if ((r as any).id !== targetInstanceId && tplKey && tplKey !== desiredTplKey) {
        report.extraInstances.push({ studentEmail, instanceId: (r as any).id, templateKey: tplKey });
      }
    }

    // 解析并绑定助教
    const assistantId = await resolveAssistantId(db, s.assignedTechAsst);
    if (!assistantId) {
      if (s.assignedTechAsst) report.missingAssistantUser.push({ studentEmail, assignedTechAsst: String(s.assignedTechAsst) });
    } else if (targetInstanceId) {
      const existing = await db.select().from(assistantStudents).where(and(
        eq(assistantStudents.assistantId as any, assistantId),
        eq(assistantStudents.studentId as any, (student as any).id),
        eq(assistantStudents.visitorInstanceId as any, targetInstanceId)
      ));
      if (!(existing as any[]).length) {
        await db.insert(assistantStudents).values({
          id: crypto.randomUUID(),
          assistantId,
          studentId: (student as any).id,
          visitorInstanceId: targetInstanceId,
          createdAt: new Date(),
        } as any);
        report.createdBindings += 1;
      }

      // 发现“绑定到其他实例/其他助教”的记录 → 报告（不删）
      const otherBinds = await db.select().from(assistantStudents).where(and(
        eq(assistantStudents.studentId as any, (student as any).id)
      ));
      for (const b of otherBinds as any[]) {
        if ((b as any).visitorInstanceId !== targetInstanceId || (b as any).assistantId !== assistantId) {
          report.wrongBindings.push({ studentEmail, assistantId: (b as any).assistantId, visitorInstanceId: (b as any).visitorInstanceId, reason: 'mismatch-with-csv' });
        }
      }

      // 校验助教 inchargeVisitor 覆盖（仅报告）
      const assistantUser = (await db.select({ email: users.email }).from(users).where(eq(users.id as any, assistantId)))[0] as any;
      const assistantEmail = assistantUser?.email;
      if (assistantEmail) {
        const scope = assistantEmailToIncharge[assistantEmail] || [];
        if (scope.length > 0 && !scope.includes(desiredTplKey)) {
          report.assistantScopeMismatch.push({ assistantEmail, studentEmail, templateKey: desiredTplKey });
        }
      }
    }
  }

  // 输出报告
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
