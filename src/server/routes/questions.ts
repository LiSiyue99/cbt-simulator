import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { questions, sessions } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';

export async function registerQuestionRoutes(app: FastifyInstance) {
  // 创建问题（学生）
  app.post('/questions', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId', 'content'],
        properties: {
          sessionId: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const payload = (req as any).auth;
    if (!payload || (payload.role !== 'student' && payload.role !== 'admin')) {
      return reply.status(403).send({ error: 'forbidden' });
    }
    const db = createDb();
    const { sessionId, content } = req.body as any;

    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });

    const id = crypto.randomUUID();
    await db.insert(questions).values({ id, sessionId, studentId: payload.userId, content, status: 'open', createdAt: new Date(), updatedAt: new Date() } as any);
    return reply.send({ id });
  });

  // 按 session 列出问题（学生和助教均可通过各自端口实现，这里开放无鉴别；生产应加范围过滤）
  app.get('/questions', {
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
    const rows = await db.select().from(questions).where(eq(questions.sessionId as any, sessionId)).orderBy(desc(questions.createdAt as any));
    return reply.send({ items: rows });
  });
}
