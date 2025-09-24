import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { assistantFeedbacks, sessions, assistantStudents } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';

export async function registerFeedbackRoutes(app: FastifyInstance) {
  // 助教创建反馈
  app.post('/assistant/feedback', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId', 'content'],
        properties: { sessionId: { type: 'string' }, content: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const { sessionId, content } = req.body as any;

    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });

    // 校验：该助教与该 session 的实例是否存在绑定
    const binds = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, (s as any).visitorInstanceId)));
    if (!binds.length) return reply.status(403).send({ error: 'forbidden' });

    const id = crypto.randomUUID();
    await db.insert(assistantFeedbacks).values({ id, sessionId, assistantId: payload.userId, content, status: 'published', createdAt: new Date(), updatedAt: new Date() } as any);
    return reply.send({ id });
  });

  // 列出某会话下的助教反馈
  app.get('/assistant/feedback', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const { sessionId } = req.query as any;
    const rows = await db.select().from(assistantFeedbacks).where(eq(assistantFeedbacks.sessionId as any, sessionId)).orderBy(desc(assistantFeedbacks.createdAt as any));
    return reply.send({ items: rows });
  });
}
