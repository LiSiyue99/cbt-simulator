import { chatComplete } from '../client/qwen';
import { appendChatTurn } from '../services/sessionCrud';
import { createDb } from '../db/client';
import { thoughtRecords, sessions } from '../db/schema';
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
 * 在会话结束后，模拟人类填写三联表。
 */
export async function submitMockThoughtRecord(sessionId: string) {
  const db = createDb();
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  const base = typeof s?.chatHistory === 'string' ? s?.chatHistory : JSON.stringify(s?.chatHistory ?? '');
  const triggeringEvent = '本周一个令我明显焦虑的瞬间';
  const thoughtsAndBeliefs = '他皱眉=我很差；若犯错=被否定（灾难化/读心术）';
  const consequences = '焦虑7/10，回避发言，晚上反刍';
  await db.insert(thoughtRecords).values({
    id: crypto.randomUUID(),
    sessionId,
    triggeringEvent,
    thoughtsAndBeliefs,
    consequences,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
}


