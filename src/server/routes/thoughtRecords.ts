import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { thoughtRecords, sessions, assistantStudents, visitorInstances } from '../../db/schema';
import { eq, desc, and } from 'drizzle-orm';

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
    // 实例归属校验：仅实例所有者可提交三联表
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
    if (!inst || (inst as any).userId !== (req as any).auth?.userId) {
      return reply.status(403).send({ error: 'forbidden' });
    }

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

  // 技术助教查看会话的三联表记录（带权限验证）
  app.get('/thought-records/by-session/:sessionId', async (req, reply) => {
    const payload = (app as any).requireRole?.(req, ['assistant_tech', 'admin']);
    if (!payload && (req as any).auth?.role !== 'assistant_tech' && (req as any).auth?.role !== 'admin') {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const actualPayload = payload || (req as any).auth;
    const db = createDb();
    const { sessionId } = req.params as any;

    // 验证该会话是否属于该助教负责的学生
    if (actualPayload.role === 'assistant_tech') {
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      if (!session) return reply.status(404).send({ error: 'session not found' });

      const [instance] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (session as any).visitorInstanceId));
      if (!instance) return reply.status(404).send({ error: 'visitor instance not found' });

      // 检查是否有绑定关系
      const [binding] = await db.select().from(assistantStudents).where(and(
        eq(assistantStudents.assistantId as any, actualPayload.userId),
        eq(assistantStudents.studentId as any, (instance as any).userId)
      ));

      if (!binding) return reply.status(403).send({ error: 'forbidden' });
    }

    // 获取三联表记录
    const rows = await db.select().from(thoughtRecords).where(eq(thoughtRecords.sessionId, sessionId)).orderBy(desc(thoughtRecords.createdAt as any));
    return reply.send({ items: rows });
  });
}


