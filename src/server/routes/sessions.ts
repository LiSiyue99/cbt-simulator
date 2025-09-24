import type { FastifyInstance } from 'fastify';
import { createSession, createSessionAuto, appendChatTurn } from '../../services/sessionCrud';
import { finalizeSessionById } from '../../services/sessionPipeline';
import { createDb } from '../../db/client';
import { sessions } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { getBeijingNow, formatWeekKey, getStudentDeadline } from '../../policy/timeWindow';

export async function registerSessionRoutes(app: FastifyInstance) {
  app.post('/sessions/start', {
    schema: {
      body: {
        type: 'object',
        required: ['visitorInstanceId'],
        properties: {
          visitorInstanceId: { type: 'string' },
          sessionNumber: { type: 'number' },
          auto: { type: 'boolean' }
        },
      },
    },
  }, async (req, reply) => {
    const { visitorInstanceId, sessionNumber, auto } = req.body as any;
    // 限时：学生在周五24:00后不可开启当周新会话
    const payload = (req as any).auth;
    if (payload && payload.role === 'student') {
      const now = getBeijingNow();
      const weekKey = formatWeekKey(now);
      const deadline = getStudentDeadline(weekKey);
      if (now > deadline) {
        return reply.status(403).send({ error: 'forbidden', code: 'student_locked_for_week', message: '本周已失去开启对话权限（北京时间）' });
      }
    }
    if (auto !== false) {
      const out = await createSessionAuto(visitorInstanceId);
      return reply.send(out);
    }
    const sessionId = await createSession({ visitorInstanceId, sessionNumber });
    return reply.send({ sessionId, sessionNumber });
  });

  // 最近一条（聊天页自动加载）
  app.get('/sessions/last', {
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
    const [row] = await db.select().from(sessions).where(eq(sessions.visitorInstanceId, visitorInstanceId)).orderBy(desc(sessions.sessionNumber)).limit(1);
    if (!row) return reply.send(null);
    return reply.send({ sessionId: row.id, sessionNumber: row.sessionNumber, chatHistory: row.chatHistory });
  });

  // 历史列表（分页）
  app.get('/sessions/list', {
    schema: {
      querystring: {
        type: 'object',
        required: ['visitorInstanceId'],
        properties: {
          visitorInstanceId: { type: 'string' },
          page: { type: 'number' },
          pageSize: { type: 'number' },
        },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const { visitorInstanceId, page = 1, pageSize = 20 } = req.query as any;
    const offset = (Number(page) - 1) * Number(pageSize);
    const rows = await db
      .select({ id: sessions.id, n: sessions.sessionNumber, createdAt: sessions.createdAt, diary: sessions.sessionDiary, act: sessions.preSessionActivity })
      .from(sessions)
      .where(eq(sessions.visitorInstanceId, visitorInstanceId))
      .orderBy(desc(sessions.sessionNumber))
      .limit(Number(pageSize))
      .offset(offset);
    const items = rows.map(r => ({ sessionId: r.id, sessionNumber: r.n, createdAt: r.createdAt, hasDiary: !!r.diary, hasActivity: !!r.act }));
    return reply.send({ items, page: Number(page), pageSize: Number(pageSize) });
  });

  // 会话详情（历史回看）
  app.get('/sessions/:sessionId', {
    schema: {
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const { sessionId } = req.params as any;
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!row) return reply.status(404).send({ error: 'session not found' });
    return reply.send({
      sessionId: row.id,
      sessionNumber: row.sessionNumber,
      chatHistory: row.chatHistory,
      sessionDiary: row.sessionDiary,
      preSessionActivity: row.preSessionActivity,
      homework: row.homework,
    });
  });

  app.post('/sessions/:sessionId/messages', {
    schema: {
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['speaker', 'content'],
        properties: {
          speaker: { type: 'string', enum: ['user', 'ai'] },
          content: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { sessionId } = req.params as any;
    const { speaker, content } = req.body as any;
    await appendChatTurn({ sessionId, speaker, content });
    return reply.send({ ok: true });
  });

  app.post('/sessions/:sessionId/finalize', {
    schema: {
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: { assignment: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { sessionId } = req.params as any;
    const { assignment } = (req.body as any) || {};
    const out = await finalizeSessionById({ sessionId, assignment });
    return reply.send(out);
  });
}


