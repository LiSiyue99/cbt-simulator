import { createDb } from '../db/client';
import { users, visitorInstances, sessions, homeworkSets, homeworkSubmissions, assistantChatMessages } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { createSessionAuto } from '../services/sessionCrud';

export async function e2eHomeworkFlow() {
  const db = createDb();
  // 取一个学生与其实例
  const [stu] = await db.select().from(users).where(eq(users.role as any, 'student' as any));
  if (!stu) { console.log('no student'); return; }
  const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (stu as any).id));
  if (!inst) { console.log('no instance'); return; }
  // 找到最近会话
  let [sess] = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, (inst as any).id)).orderBy(desc(sessions.sessionNumber as any)).limit(1);
  if (!sess) {
    const created = await createSessionAuto((inst as any).id);
    const rows = await db.select().from(sessions).where(eq(sessions.id as any, created.sessionId)).limit(1);
    sess = rows[0] as any;
  }

  // Admin 发包：该班第 N 次作业
  const classId = ((stu as any).classId ?? 1) as number;
  const setId = crypto.randomUUID();
  const now = new Date();
  await db.insert(homeworkSets).values({
    id: setId,
    classId,
    title: 'E2E 作业',
    description: 'E2E 测试作业',
    sequenceNumber: (sess as any).sessionNumber,
    formFields: [
      { key: 'field1', label: '字段1', type: 'text', placeholder: '请输入' },
      { key: 'field2', label: '字段2', type: 'textarea' }
    ] as any,
    studentStartAt: now,
    studentDeadline: new Date(now.getTime() + 24*3600*1000),
    assistantStartAt: now,
    assistantDeadline: new Date(now.getTime() + 3*24*3600*1000),
    status: 'published',
    createdBy: (stu as any).id,
    createdAt: now,
    updatedAt: now,
  } as any);

  // 学生提交
  const subId = crypto.randomUUID();
  await db.insert(homeworkSubmissions).values({
    id: subId,
    homeworkSetId: setId,
    sessionId: (sess as any).id,
    studentId: (stu as any).id,
    formData: { field1: 'a', field2: 'b' } as any,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);

  // 助教回复
  const chatId = crypto.randomUUID();
  await db.insert(assistantChatMessages).values({
    id: chatId,
    sessionId: (sess as any).id,
    senderRole: 'assistant_tech',
    senderId: (stu as any).id, // 测试环境未严格校验助教id
    content: '已批改',
    createdAt: new Date(),
  } as any);

  console.log('E2E homework flow inserted');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  e2eHomeworkFlow().catch((e)=>{ console.error(e); process.exit(1); });
}


