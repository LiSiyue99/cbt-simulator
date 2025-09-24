import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { users, assistantStudents, sessions, visitorInstances, weeklyCompliance } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { computeClassWeekCompliance } from '../../services/compliance';

export async function registerAssistantClassRoutes(app: FastifyInstance) {
  // 行政助教：查看自己班级学生列表
  app.get('/assistant-class/students', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const db = createDb();

    const rows = await db.select().from(users).where(eq(users.classId as any, (payload as any).classId));
    const students = (rows as any[]).filter(r => r.role === 'student');
    return reply.send({ items: students.map(s => ({ studentId: s.id, name: s.name, email: s.email, userId: (s as any).userId })) });
  });

  // 行政助教：按学生查看会话（只读）
  app.get('/assistant-class/students/:studentId/sessions', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const { studentId } = req.params as any;
    const db = createDb();

    // 验证该学生属于此行政助教的班级
    const [stu] = await db.select().from(users).where(eq(users.id as any, studentId));
    if (!stu || (stu as any).role !== 'student' || (stu as any).classId !== (payload as any).classId) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    // 找到该学生拥有的 visitor instance（一个）
    const vis = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, studentId));
    if (!vis.length) return reply.send({ items: [] });

    const rows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, (vis[0] as any).id)).orderBy(desc(sessions.sessionNumber as any));
    return reply.send({ items: rows.map(r => ({ sessionId: (r as any).id, sessionNumber: (r as any).sessionNumber, createdAt: (r as any).createdAt })) });
  });

  // 行政助教：周合规报告
  app.get('/assistant-class/compliance', {
    schema: {
      querystring: {
        type: 'object',
        properties: { week: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const db = createDb();
    const { week } = req.query as any;

    await computeClassWeekCompliance((payload as any).classId, week);

    const rows = await db.select().from(weeklyCompliance).where(eq(weeklyCompliance.classId as any, (payload as any).classId));
    const items = (rows as any[]).filter(r => !week || r.weekKey === week);
    return reply.send({ items });
  });
}
