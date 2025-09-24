import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { thoughtRecords, sessions } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';

export async function registerThoughtRecordRoutes(app: FastifyInstance) {
  // 创建三联表记录（人类用户提交）
  app.post('/thought-records', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId', 'triggeringEvent', 'thoughtsAndBeliefs', 'consequences'],
        properties: {
          sessionId: { type: 'string' },
          triggeringEvent: { type: 'string' },
          thoughtsAndBeliefs: { type: 'string' },
          consequences: { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const db = createDb();
    const { sessionId, triggeringEvent, thoughtsAndBeliefs, consequences } = req.body as any;
    // 校验 session 存在
    const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });

    const id = crypto.randomUUID();
    await db.insert(thoughtRecords).values({
      id,
      sessionId,
      triggeringEvent,
      thoughtsAndBeliefs,
      consequences,
      createdAt: new Date(),
      updatedAt: new Date()
    } as any);
    return reply.send({ id });
  });

  // 查询某会话下的三联表记录（供回显/编辑）
  app.get('/thought-records', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } }
      }
    }
  }, async (req, reply) => {
    const db = createDb();
    const { sessionId } = req.query as any;
    const rows = await db.select().from(thoughtRecords).where(eq(thoughtRecords.sessionId, sessionId)).orderBy(desc(thoughtRecords.createdAt as any));
    return reply.send({ items: rows });
  });
}


