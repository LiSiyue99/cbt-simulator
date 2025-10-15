import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { createDb } from '../db/client';
import { users, whitelistEmails, visitorTemplates, visitorInstances, assistantStudents } from '../db/schema';
import { userRoleGrants } from '../db/schema';
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
  assignedVisitor?: string; // '1'..'10'
  inchargeVisitor?: string; // JSON string of ["1","5"]
  studentCount?: string;
  status?: 'active' | 'inactive';
};

function cleanEmail(e: string): string {
  return (e || '')
    .replace(/[\u2000-\u200B\u3000]/g, '') // 去除零宽/全角空白
    .replace(/\s+/g, '') // 去除任何普通空格（防止中间混入空格）
    .trim()
    .toLowerCase();
}

function required<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null || v === '') throw new Error(msg);
  return v;
}

async function readCsv(filePath: string): Promise<WhitelistRow[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  return new Promise((resolve, reject) => {
    parse(
      content,
      { columns: true, trim: true, relaxQuotes: true, skipEmptyLines: true, bom: true },
      (err, records: any[]) => {
        if (err) return reject(err);
        resolve(records as WhitelistRow[]);
      }
    );
  });
}

async function upsertWhitelistEmails(rows: WhitelistRow[]) {
  const db = createDb();
  for (const r of rows) {
    const email = cleanEmail(r.email);
    if (!email) continue;
    const [existing] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, email));
    const payload: any = {
      email,
      name: r.name || null,
      userId: r.userId || r.studentNo || null,
      role: r.role,
      classId: r.classId || null,
      assignedVisitor: r.assignedVisitor || null,
      inchargeVisitor: r.inchargeVisitor ? JSON.parse(r.inchargeVisitor) : null,
      studentCount: r.studentCount ? Number(r.studentCount) : 0,
      status: (r.status as any) || 'active',
      updatedAt: new Date(),
    };
    if (!existing) {
      await db.insert(whitelistEmails).values({
        ...payload,
        createdAt: new Date(),
      });
    } else {
      await db.update(whitelistEmails).set(payload).where(eq(whitelistEmails.email as any, email));
    }
  }
}

async function upsertUsersFromWhitelist(rows: WhitelistRow[]) {
  const db = createDb();
  for (const r of rows) {
    const email = cleanEmail(r.email);
    if (!email) continue;
    const [existing] = await db.select().from(users).where(eq(users.email as any, email));
    if (!existing) {
      await db.insert(users).values({
        id: crypto.randomUUID(),
        email,
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

async function upsertUserRoleGrants(rows: WhitelistRow[]) {
  const db = createDb();
  // 仅处理 assistant_class 行：为对应用户授予行政助教角色与班级作用域
  for (const r of rows.filter(r => r.role === 'assistant_class')) {
    const email = cleanEmail(r.email);
    if (!email) continue;
    const [u] = await db.select().from(users).where(eq(users.email as any, email));
    if (!u) continue;
    // 检查是否已有相同授权
    const existing = await db.select().from(userRoleGrants)
      .where(eq(userRoleGrants.userId as any, (u as any).id));
    const hasGrant = (existing as any[]).some(g => (g as any).role === 'assistant_class' && (g as any).classId === (r.classId ? Number(r.classId) : null));
    if (!hasGrant) {
      await db.insert(userRoleGrants).values({
        id: crypto.randomUUID(),
        userId: (u as any).id,
        role: 'assistant_class',
        classId: r.classId ? Number(r.classId) : null,
        createdAt: new Date(),
      } as any);
    }
  }
}

async function assignStudents(rows: WhitelistRow[]) {
  const db = createDb();
  const students = rows.filter(r => r.role === 'student');

  const summary = { totalCSVStudents: students.length, matchedUsers: 0, alreadyHadAnyInstance: 0, createdInstances: 0 };

  // 读取模板 map
  const tplRows = await db.select().from(visitorTemplates);
  const keyToTemplateId: Record<string, string> = {};
  for (const t of tplRows as any[]) {
    keyToTemplateId[(t as any).templateKey] = (t as any).id;
  }

  for (const s of students) {
    const email = cleanEmail(s.email);
    if (!email) continue;
    const [u] = await db.select().from(users).where(eq(users.email as any, email));
    if (!u) continue;
    summary.matchedUsers += 1;

    // 判断该学生是否已有 visitor instance
    const existing = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (u as any).id));
    if (existing.length) { summary.alreadyHadAnyInstance += 1; continue; }

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
    summary.createdInstances += 1;
  }

  return summary;
}

async function main() {
  const csvFile = process.argv[2];
  if (!csvFile) throw new Error('Usage: tsx src/main/importWhitelist.ts <csv_file_path>');
  const rows = await readCsv(path.resolve(csvFile));
  await upsertWhitelistEmails(rows);
  await upsertUsersFromWhitelist(rows);
  await upsertUserRoleGrants(rows);
  const summary = await assignStudents(rows);
  console.log(JSON.stringify({ ok: true, summary }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
