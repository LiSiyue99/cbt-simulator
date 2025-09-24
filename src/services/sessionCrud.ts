import { createDb } from '../db/client';
import { sessions } from '../db/schema';
import { eq, desc } from 'drizzle-orm';

export async function createSession(params: {
  visitorInstanceId: string;
  sessionNumber: number;
}): Promise<string> {
  const db = createDb();
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    visitorInstanceId: params.visitorInstanceId,
    sessionNumber: params.sessionNumber,
    chatHistory: [] as any,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
  return id;
}

export async function appendChatTurn(params: {
  sessionId: string;
  speaker: 'user' | 'ai';
  content: string;
}): Promise<void> {
  const db = createDb();
  const [row] = await db.select().from(sessions).where(eq(sessions.id, params.sessionId));
  const history = Array.isArray(row?.chatHistory) ? row!.chatHistory : [];
  history.push({ speaker: params.speaker, content: params.content, timestamp: new Date().toISOString() });
  await db
    .update(sessions)
    .set({ chatHistory: history as any, updatedAt: new Date() })
    .where(eq(sessions.id, params.sessionId));
}

/**
 * 自动分配 sessionNumber：根据 visitorInstanceId 查最大值并 +1。
 */
export async function createSessionAuto(visitorInstanceId: string): Promise<{ sessionId: string; sessionNumber: number }> {
  const db = createDb();
  const rows = await db
    .select({ n: sessions.sessionNumber })
    .from(sessions)
    .where(eq(sessions.visitorInstanceId, visitorInstanceId))
    .orderBy(desc(sessions.sessionNumber))
    .limit(1);
  const next = (rows[0]?.n ?? 0) + 1;
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    visitorInstanceId,
    sessionNumber: next,
    chatHistory: [] as any,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
  return { sessionId: id, sessionNumber: next };
}


