import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { assistantStudents, users, sessions, longTermMemoryVersions, visitorInstances } from '../../db/schema';
import { eq, desc, and } from 'drizzle-orm';

export async function registerAssistantRoutes(app: FastifyInstance) {
  // 当前助教负责的 visitor 实例概览
  app.get('/assistant/visitors', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const rows = await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, payload.userId));
    const byInstance: Record<string, { visitorInstanceId: string; studentCount: number }> = {};
    for (const r of rows as any[]) {
      if (!byInstance[r.visitorInstanceId]) byInstance[r.visitorInstanceId] = { visitorInstanceId: r.visitorInstanceId, studentCount: 0 };
      byInstance[r.visitorInstanceId].studentCount += 1;
    }
    return reply.send({ items: Object.values(byInstance) });
  });

  // 某 visitor 实例下的学生列表（含最近会话时间与次数）
  app.get('/assistant/students', {
    schema: {
      querystring: {
        type: 'object',
        required: ['visitorInstanceId'],
        properties: { visitorInstanceId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const { visitorInstanceId } = req.query as any;

    // 权限校验：该助教是否与该实例有绑定
    const [bind] = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, visitorInstanceId)));
    if (!bind) return reply.status(403).send({ error: 'forbidden' });

    const rows = await db.select().from(assistantStudents).where(eq(assistantStudents.visitorInstanceId as any, visitorInstanceId));
    const result = [] as any[];
    for (const r of rows as any[]) {
      const [u] = await db.select().from(users).where(eq(users.id as any, r.studentId));
      const sess = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, r.visitorInstanceId)).orderBy(desc(sessions.createdAt as any));
      result.push({ studentId: r.studentId, studentEmail: u?.email, studentName: u?.name, sessionCount: sess.length, lastSessionAt: sess[0]?.createdAt || null });
    }
    return reply.send({ items: result });
  });

  // 按学生查看其所有会话（供助教回看）
  app.get('/assistant/students/:studentId/sessions', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const { studentId } = req.params as any;

    // 找到绑定的 visitorInstanceId 列表
    const binds = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.studentId as any, studentId)));
    if (!binds.length) return reply.status(403).send({ error: 'forbidden' });

    const instanceIds = [...new Set(binds.map((b: any) => b.visitorInstanceId))];
    const result: any[] = [];
    for (const vid of instanceIds) {
      const rows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, vid)).orderBy(desc(sessions.sessionNumber as any));
      for (const s of rows as any[]) {
        result.push({ sessionId: s.id, sessionNumber: s.sessionNumber, createdAt: s.createdAt });
      }
    }
    return reply.send({ items: result });
  });

  // 学生历史：活动/日记/作业/LTM 历史
  app.get('/assistant/students/:studentId/history', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const { studentId } = req.params as any;

    // 校验绑定
    const binds = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.studentId as any, studentId)));
    if (!binds.length) return reply.status(403).send({ error: 'forbidden' });

    // 假定一个学生仅一个 instance
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, studentId));
    if (!inst) return reply.send({ diary: [], activity: [], homework: [], ltm: [] });

    const sessRows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, (inst as any).id)).orderBy(desc(sessions.sessionNumber as any));
    const ltmRows = await db.select().from(longTermMemoryVersions).where(eq(longTermMemoryVersions.visitorInstanceId as any, (inst as any).id)).orderBy(desc(longTermMemoryVersions.createdAt as any));

    const diary = (sessRows as any[]).filter(s => !!s.sessionDiary).map(s => ({ sessionNumber: s.sessionNumber, sessionId: s.id, createdAt: s.createdAt, sessionDiary: s.sessionDiary }));
    const activity = (sessRows as any[]).filter(s => !!s.preSessionActivity).map(s => ({ sessionNumber: s.sessionNumber, sessionId: s.id, createdAt: s.createdAt, preSessionActivity: s.preSessionActivity }));
    const homework = (sessRows as any[]).filter(s => Array.isArray(s.homework) && s.homework?.length > 0).map(s => ({ sessionNumber: s.sessionNumber, sessionId: s.id, createdAt: s.createdAt, homework: s.homework }));
    const ltm = (ltmRows as any[]).map(r => ({ createdAt: r.createdAt, content: r.content }));

    return reply.send({ diary, activity, homework, ltm });
  });
}
