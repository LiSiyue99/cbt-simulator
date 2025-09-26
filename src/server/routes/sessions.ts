import type { FastifyInstance } from 'fastify';
import { createSession, createSessionAuto, appendChatTurn } from '../../services/sessionCrud';
import { finalizeSessionById, prepareNewSession } from '../../services/sessionPipeline';
import { createDb } from '../../db/client';
import { sessions, visitorInstances, visitorTemplates, thoughtRecords, longTermMemoryVersions } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { getBeijingNow, formatWeekKey, getStudentDeadline } from '../../policy/timeWindow';
import { chatWithVisitor, type FullPersona, type ChatTurn } from '../../chat/sessionOrchestrator';

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
    // 如果上一条会话未完成，则不允许开始下一次；若已完成则返回 finalizedAt
    return reply.send({ sessionId: row.id, sessionNumber: row.sessionNumber, chatHistory: row.chatHistory, finalizedAt: row.finalizedAt });
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
          includePreview: { type: 'boolean' }
        },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const { visitorInstanceId, page = 1, pageSize = 20, includePreview = false } = req.query as any;
    const offset = (Number(page) - 1) * Number(pageSize);
    const rows = await db
      .select({
        id: sessions.id,
        n: sessions.sessionNumber,
        createdAt: sessions.createdAt,
        finalizedAt: sessions.finalizedAt,
        diary: sessions.sessionDiary,
        act: sessions.preSessionActivity,
        chatHistory: sessions.chatHistory
      })
      .from(sessions)
      .where(eq(sessions.visitorInstanceId, visitorInstanceId))
      .orderBy(desc(sessions.sessionNumber))
      .limit(Number(pageSize))
      .offset(offset);

    const items = await Promise.all(rows.map(async (r) => {
      // Count messages
      const chatHistory = (r.chatHistory as any[]) || [];
      const messageCount = chatHistory.length;

      // Check for thought records
      const thoughtRecordsResult = await db
        .select({ id: thoughtRecords.id })
        .from(thoughtRecords)
        .where(eq(thoughtRecords.sessionId as any, r.id));

      // Get last message for preview
      let lastMessage = null;
      if (includePreview && chatHistory.length > 0) {
        const lastMsg = chatHistory[chatHistory.length - 1];
        lastMessage = {
          speaker: lastMsg.speaker,
          content: lastMsg.content,
          timestamp: lastMsg.timestamp
        };
      }

      return {
        sessionId: r.id,
        sessionNumber: r.n,
        createdAt: r.createdAt,
        completed: !!r.finalizedAt,
        messageCount,
        hasDiary: !!r.diary,
        hasActivity: !!r.act,
        hasThoughtRecord: thoughtRecordsResult.length > 0,
        ...(lastMessage && { lastMessage })
      };
    }));

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

    // 实例归属校验：仅允许实例所有者写入
    const dbOwnership = createDb();
    const [sessRow] = await dbOwnership.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!sessRow) return reply.status(404).send({ error: 'session not found' });
    const [instRow] = await dbOwnership.select().from(visitorInstances).where(eq(visitorInstances.id as any, (sessRow as any).visitorInstanceId));
    const ownerId = (instRow as any)?.userId;
    if (!ownerId || ownerId !== (req as any).auth?.userId) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    // Store the user message
    await appendChatTurn({ sessionId, speaker, content });

    // If it's a user message, generate AI response
    if (speaker === 'user') {
      const db = createDb();

      // Get session and visitor instance info
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      if (!session) return reply.status(404).send({ error: 'session not found' });

      const [visitorInstance] = await db.select()
        .from(visitorInstances)
        .where(eq(visitorInstances.id as any, (session as any).visitorInstanceId));
      if (!visitorInstance) return reply.status(404).send({ error: 'visitor instance not found' });

      const [visitorTemplate] = await db.select()
        .from(visitorTemplates)
        .where(eq(visitorTemplates.id as any, (visitorInstance as any).templateId));
      if (!visitorTemplate) return reply.status(404).send({ error: 'visitor template not found' });

      // Build full persona
      const fullPersona: FullPersona = {
        corePersona: typeof (visitorTemplate as any).corePersona === 'string'
          ? (visitorTemplate as any).corePersona
          : JSON.stringify((visitorTemplate as any).corePersona || ''),
        chatPrinciple: (visitorTemplate as any).chatPrinciple || '',
        longTermMemory: (visitorInstance as any).longTermMemory || ''
      };

      // Convert session history to chat turns format
      const sessionHistory = (session as any).chatHistory || [];
      const messages: ChatTurn[] = sessionHistory.map((turn: any) => ({
        role: turn.speaker === 'user' ? 'user' : 'assistant',
        content: turn.content
      }));

      // Add the new user message
      messages.push({ role: 'user', content });

      // Generate AI response
      const aiResponse = await chatWithVisitor({
        persona: fullPersona,
        messages: messages
      });

      // Store AI response
      await appendChatTurn({ sessionId, speaker: 'ai', content: aiResponse });

      return reply.send({
        ok: true,
        aiResponse: {
          speaker: 'ai',
          content: aiResponse,
          timestamp: new Date().toISOString()
        }
      });
    }

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
    try {
      const out = await finalizeSessionById({ sessionId, assignment });
      return reply.send(out);
    } catch (e: any) {
      (req as any).log?.error({ err: e }, 'finalizeSession failed');
      return reply.status(500).send({ error: 'finalize_failed', message: e?.message || 'unknown error' });
    }
  });

  // 新对话前期准备：生成activity并更新LTM
  app.post('/sessions/:sessionId/prepare', {
    schema: {
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { sessionId } = req.params as any;
    try {
      const result = await prepareNewSession(sessionId);
      return reply.send(result);
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // 补偿接口：确保指定 session 的 diary/activity/LTM 均已生成；若缺失则重试生成
  app.post('/sessions/:sessionId/ensure-outputs', {
    schema: {
      params: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { sessionId } = req.params as any;
    const db = createDb();
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!row) return reply.status(404).send({ error: 'session not found' });

    const needDiary = !row.sessionDiary;
    const needActivity = !row.preSessionActivity;
    let regenerated = false;

    if (needDiary || needActivity) {
      // 复用 finalize + prepare 的逻辑：若 diary 缺失，先补 diary；若 activity 缺失，基于该 session 生成 activity 并更新 LTM
      if (needDiary) {
        await finalizeSessionById({ sessionId, assignment: (row as any).homework?.[0]?.title });
        regenerated = true;
      }
      if (needActivity) {
        // prepareNewSession 接口基于上一个已完成会话生成，这里直接用当前 session 作为“上一条”输入：
        // 简化处理：若 finalize 已生成 diary，这里直接调用 prepareNewSession(current) 让其以 current 作为参照。
        await prepareNewSession(sessionId);
        regenerated = true;
      }
    }

    // 返回最新状态（含 LTM 就绪）
    const [row2] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (row2 as any).visitorInstanceId));
    const ltmOk = !!(inst as any)?.longTermMemory && Object.keys((inst as any).longTermMemory || {}).length > 0;
    const ltmHist = await db
      .select({ id: longTermMemoryVersions.id })
      .from(longTermMemoryVersions)
      .where(eq(longTermMemoryVersions.visitorInstanceId as any, (row2 as any).visitorInstanceId));
    return reply.send({
      ok: true,
      regenerated,
      hasDiary: !!row2.sessionDiary,
      hasActivity: !!row2.preSessionActivity,
      hasLtm: ltmOk && ltmHist.length > 0,
    });
  });
}


