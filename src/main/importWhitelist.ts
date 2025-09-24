import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { createDb } from '../db/client';
import { users, whitelistEmails, visitorTemplates, visitorInstances, assistantStudents } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';

/**
 * 用法：
 * tsx src/main/importWhitelist.ts <csv_file_path>
 */

type WhitelistRow = {
  email: string;
  name?: string;
  userId?: string;
  role: 'student' | 'assistant_tech' | 'assistant_class' | 'admin';
  classId?: string;
  studentNo?: string; // 输入别名，将写入 users.userId
  assignedTechAsst?: string;
  assignedClassAsst?: string;
  assignedVisitor?: string; // '1'..'10'
  inchargeVisitor?: string; // JSON string of ["1","5"]
  studentCount?: string;
  status?: 'active' | 'inactive';
};

function required<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null || v === '') throw new Error(msg);
  return v;
}

async function readCsv(filePath: string): Promise<WhitelistRow[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  return new Promise((resolve, reject) => {
    parse(content, { columns: true, trim: true }, (err, records: any[]) => {
      if (err) return reject(err);
      resolve(records as WhitelistRow[]);
    });
  });
}

async function upsertUsersFromWhitelist(rows: WhitelistRow[]) {
  const db = createDb();
  for (const r of rows) {
    const [existing] = await db.select().from(users).where(eq(users.email as any, r.email));
    if (!existing) {
      await db.insert(users).values({
        id: crypto.randomUUID(),
        email: r.email,
        name: r.name || null,
        userId: r.userId || r.studentNo || null,
        role: r.role,
        classId: r.classId || null,
        status: (r.status as any) || 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
    } else {
      await db.update(users).set({
        name: r.name || existing.name,
        userId: r.userId || r.studentNo || (existing as any).userId,
        role: r.role || existing.role,
        classId: r.classId || (existing as any).classId,
        status: (r.status as any) || (existing as any).status,
        updatedAt: new Date(),
      } as any).where(eq(users.id as any, (existing as any).id));
    }
  }
}

async function assignStudents(rows: WhitelistRow[]) {
  const db = createDb();
  const students = rows.filter(r => r.role === 'student');

  // 读取模板 map
  const tplRows = await db.select().from(visitorTemplates);
  const keyToTemplateId: Record<string, string> = {};
  for (const t of tplRows as any[]) {
    // 模板表需包含 templateKey 字段
    keyToTemplateId[(t as any).templateKey] = (t as any).id;
  }

  // 技术助教查找表：userId/email 映射到 users.id
  const assistantByUserId: Record<string, string> = {};
  const assistantByEmail: Record<string, string> = {};
  for (const r of rows.filter(r => r.role === 'assistant_tech')) {
    const [u] = await db.select().from(users).where(eq(users.email as any, r.email));
    if (u) {
      if (r.userId) assistantByUserId[r.userId] = (u as any).id;
      assistantByEmail[r.email] = (u as any).id;
    }
  }

  for (const s of students) {
    const [u] = await db.select().from(users).where(eq(users.email as any, s.email));
    if (!u) continue;

    // 判断该学生是否已有 visitor instance
    const existing = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (u as any).id));
    if (existing.length) continue;

    const templateKey = s.assignedVisitor || String(((Math.random() * 10) | 0) + 1);
    const templateId = keyToTemplateId[templateKey];
    if (!templateId) throw new Error(`模板 ${templateKey} 未找到，请先初始化 visitor_templates`);

    const instanceId = crypto.randomUUID();
    await db.insert(visitorInstances).values({
      id: instanceId,
      userId: (u as any).id,
      templateId,
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

    // 助教绑定（如果指定了 assignedTechAsst）
    let assistantId: string | undefined;
    if (s.assignedTechAsst) {
      assistantId = assistantByUserId[s.assignedTechAsst] || assistantByEmail[s.assignedTechAsst];
    }
    if (assistantId) {
      await db.insert(assistantStudents).values({
        id: crypto.randomUUID(),
        assistantId,
        studentId: (u as any).id,
        visitorInstanceId: instanceId,
        createdAt: new Date(),
      } as any);
    }
  }
}

async function main() {
  const csvFile = process.argv[2];
  if (!csvFile) throw new Error('Usage: tsx src/main/importWhitelist.ts <csv_file_path>');
  const rows = await readCsv(path.resolve(csvFile));
  await upsertUsersFromWhitelist(rows);
  await assignStudents(rows);
  console.log('Whitelist import completed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
