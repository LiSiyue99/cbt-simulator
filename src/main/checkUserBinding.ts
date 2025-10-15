import 'dotenv/config';
import { createDb } from '../db/client';
import { users, whitelistEmails, userRoleGrants, visitorInstances, visitorTemplates, assistantStudents } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';

/**
 * 只读诊断脚本：按邮箱核查用户角色、白名单、访客实例/模板、与技术助教绑定
 * 用法： npx tsx src/main/checkUserBinding.ts <email>
 */
async function main() {
  const emailArg = process.argv[2];
  if (!emailArg) {
    console.error('Usage: tsx src/main/checkUserBinding.ts <email>');
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();

  const db = createDb();

  const [user] = await db.select().from(users).where(eq(users.email as any, email));
  const [white] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, email));

  if (!user) {
    console.log(JSON.stringify({ ok: false, reason: 'user_not_found', email }, null, 2));
    return;
  }

  const grants = await db.select().from(userRoleGrants).where(eq(userRoleGrants.userId as any, (user as any).id));

  // 访客实例及模板
  const instances = await db.select({ id: visitorInstances.id, templateId: visitorInstances.templateId })
    .from(visitorInstances).where(eq(visitorInstances.userId as any, (user as any).id));
  const tplIds = Array.from(new Set((instances as any[]).map(i => (i as any).templateId)));
  const tplRows = tplIds.length
    ? await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey, name: visitorTemplates.name })
        .from(visitorTemplates).where(inArray(visitorTemplates.id as any, tplIds as any))
    : [];
  const tplKeyById = new Map<string, { key: string; name: string }>((tplRows as any[]).map(t => [(t as any).id, { key: (t as any).templateKey, name: (t as any).name }]));

  const instanceDetails = (instances as any[]).map(i => ({
    id: (i as any).id,
    templateId: (i as any).templateId,
    templateKey: tplKeyById.get((i as any).templateId)?.key || null,
    templateName: tplKeyById.get((i as any).templateId)?.name || null,
  }));

  // 作为学生被哪个技术助教负责（assistant_students）
  const asStudentBinds = await db.select().from(assistantStudents).where(eq(assistantStudents.studentId as any, (user as any).id));
  const assistantIds = Array.from(new Set((asStudentBinds as any[]).map(b => (b as any).assistantId)));
  const assistantUsers = assistantIds.length ? await db.select({ id: users.id, email: users.email, name: users.name, role: users.role }).from(users).where(inArray(users.id as any, assistantIds as any)) : [];
  const assistantById = new Map<string, any>((assistantUsers as any[]).map(u => [(u as any).id, u]));

  const studentBindings = (asStudentBinds as any[]).map(b => ({
    assistantId: (b as any).assistantId,
    assistantEmail: assistantById.get((b as any).assistantId)?.email || null,
    assistantName: assistantById.get((b as any).assistantId)?.name || null,
    assistantRole: assistantById.get((b as any).assistantId)?.role || null,
    visitorInstanceId: (b as any).visitorInstanceId,
    visitorTemplateKey: instanceDetails.find(i => i.id === (b as any).visitorInstanceId)?.templateKey || null,
  }));

  const result = {
    ok: true,
    user: {
      id: (user as any).id,
      email: (user as any).email,
      name: (user as any).name,
      role: (user as any).role,
      classId: (user as any).classId,
    },
    whitelist: white ? {
      role: (white as any).role,
      classId: (white as any).classId,
      assignedVisitor: (white as any).assignedVisitor,
      inchargeVisitor: (white as any).inchargeVisitor,
    } : null,
    grants: (grants as any[]).map(g => ({ role: (g as any).role, classId: (g as any).classId })),
    instances: instanceDetails,
    studentBindings,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });


