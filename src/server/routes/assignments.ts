import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { sessions, visitorInstances, assistantStudents, thoughtRecords, questions, assistantFeedbacks } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';

export async function registerAssignmentRoutes(app: FastifyInstance) {
  // 学生端作业汇总：按实例列出所有会话的作业与互动状态
  app.get('/assignments/list', {
    schema: {
      querystring: {
        type: 'object',
        required: ['visitorInstanceId'],
        properties: { visitorInstanceId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const { visitorInstanceId } = req.query as any;
    const payload = (req as any).auth;

    // 授权：
    // - student: 必须拥有该 visitorInstanceId
    // - assistant/admin: 必须在 assistant_students 绑定内或为 admin
    if (!payload) return reply.status(401).send({ error: 'unauthorized' });

    if (payload.role === 'student') {
      const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
      if (!inst || (inst as any).userId !== payload.userId) return reply.status(403).send({ error: 'forbidden' });
    } else if (payload.role === 'assistant_tech') {
      const [bind] = await db
        .select()
        .from(assistantStudents)
        .where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, visitorInstanceId)));
      if (!bind) return reply.status(403).send({ error: 'forbidden' });
    } else if (payload.role === 'admin') {
      // allow
    } else {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const sessRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.visitorInstanceId as any, visitorInstanceId))
      .orderBy(desc(sessions.sessionNumber as any));

    const items = [] as any[];
    for (const s of sessRows as any[]) {
      const sessionId = s.id;
      const tr = await db.select().from(thoughtRecords).where(eq(thoughtRecords.sessionId as any, sessionId));
      const qs = await db.select().from(questions).where(eq(questions.sessionId as any, sessionId));
      const fb = await db.select().from(assistantFeedbacks).where(eq(assistantFeedbacks.sessionId as any, sessionId));
      items.push({
        sessionId,
        sessionNumber: s.sessionNumber,
        createdAt: s.createdAt,
        homework: s.homework || [],
        thoughtRecordCount: tr.length,
        questionCount: qs.length,
        feedbackCount: fb.length,
      });
    }

    return reply.send({ items });
  });
}
