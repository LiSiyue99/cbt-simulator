import { chatComplete } from '../client/qwen';
import { appendChatTurn } from '../services/sessionCrud';
import { createDb } from '../db/client';
import { sessions, homeworkSubmissions, homeworkSets, users, visitorInstances } from '../db/schema';
import { eq } from 'drizzle-orm';

/**
 * 使用 Qwen-Flash 生成“模拟人类用户”的下一条消息。
 * 约束：输出尽量简短、自然，避免专业术语。
 */
export async function generateMockHumanReply(context: {
  lastAssistantMsg?: string;
  goal?: string;
}): Promise<string> {
  const system = '你现在扮演一名心理咨询师，和AI visitor对话，了解他的问题，推进对话。请用简短自然的中文表达，每次回复不超过3句话。';
  const seed = context.goal ?? '开始与AI访客交流。';
  const content = context.lastAssistantMsg
    ? `上一条AI访客的回复是：\n${context.lastAssistantMsg}\n你作为心理咨询师，基于上面的回复，自然地继续对话。`
    : seed;
  const out = await chatComplete({
    model: 'qwen-flash',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  });
  return out.trim();
}

/**
 * 在会话结束后，模拟人类提交作业。
 */
export async function submitMockThoughtRecord(sessionId: string) {
  const db = createDb();
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  const base = typeof s?.chatHistory === 'string' ? s?.chatHistory : JSON.stringify(s?.chatHistory ?? '');
  // 找到该 session 所属学生与班级，并匹配或创建一个 mock 作业集
  const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
  const [stu] = await db.select().from(users).where(eq(users.id as any, (inst as any).userId));
  const seq = (s as any).sessionNumber;
  let [setRow] = await db.select().from(homeworkSets).where((homeworkSets.classId as any).eq ? (homeworkSets.classId as any).eq((stu as any).classId) : (homeworkSets.classId as any));
  if (!setRow || (setRow as any).sequenceNumber !== seq) {
    const now = new Date();
    const id = crypto.randomUUID();
    await db.insert(homeworkSets).values({
      id,
      classId: (stu as any).classId,
      title: 'Mock 作业',
      description: '用于测试的作业',
      sequenceNumber: seq,
      formFields: [
        { key: 'situation', label: '情境', type: 'textarea', placeholder: '发生了什么', helpText: '简述触发事件' },
        { key: 'thoughts', label: '想法', type: 'textarea', placeholder: '你在想什么', helpText: '自动化思维' },
        { key: 'consequence', label: '后果', type: 'textarea', placeholder: '产生了什么影响', helpText: '情绪/行为' },
      ],
      studentStartAt: now,
      studentDeadline: new Date(now.getTime() + 3*24*3600*1000),
      assistantStartAt: now,
      assistantDeadline: new Date(now.getTime() + 7*24*3600*1000),
      status: 'published',
      createdBy: (stu as any).id,
      createdAt: now,
      updatedAt: now,
    } as any);
    const rows = await db.select().from(homeworkSets).where((homeworkSets.id as any).eq ? (homeworkSets.id as any).eq(id) : (homeworkSets.id as any));
    setRow = rows[0];
  }

  await db.insert(homeworkSubmissions).values({
    id: crypto.randomUUID(),
    homeworkSetId: (setRow as any).id,
    sessionId,
    studentId: (stu as any).id,
    formData: { situation: '一个令我焦虑的瞬间', thoughts: '他皱眉=我很差', consequence: '焦虑7/10' } as any,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
}


