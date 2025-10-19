import type { FastifyInstance } from 'fastify';
import { createSession, createSessionAuto, appendChatTurn } from '../../services/sessionCrud';
import { finalizeSessionById, prepareNewSession } from '../../services/sessionPipeline';
import { createDb } from '../../db/client';
import { sessions, visitorInstances, visitorTemplates, longTermMemoryVersions, assistantStudents, homeworkSubmissions, users, homeworkSets } from '../../db/schema';
import { eq, desc, sql, and } from 'drizzle-orm';
// 周维度时间窗已废弃，现改为基于 homework_sets 的绝对窗口；不再引入 policy/timeWindow
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
    // 已移除“按周开放/截止”的限制；仅学生保留未完成阻断与一小时冷却
    const payload = (req as any).auth;
    if (payload && payload.role === 'student') {
      const db = createDb();
      // 若存在未完成会话，禁止创建下一次，返回进行中的会话信息
      const [lastRow] = await db.select().from(sessions).where(eq(sessions.visitorInstanceId, visitorInstanceId)).orderBy(desc(sessions.sessionNumber)).limit(1);
      if (lastRow && !(lastRow as any).finalizedAt) {
        return reply.status(409).send({ error: 'session_unfinished', sessionId: (lastRow as any).id, sessionNumber: (lastRow as any).sessionNumber });
      }

      // 一小时冷却（防刷保护）
      const now2 = new Date();
      const oneHourAgo = new Date(now2.getTime() - 60 * 60 * 1000);
      const createdRecently = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(sql`${sessions.visitorInstanceId} = ${visitorInstanceId} AND ${sessions.createdAt} >= ${oneHourAgo}`)
        .limit(1);
      if ((createdRecently as any[]).length > 0) {
        return reply.status(403).send({ error: 'forbidden', code: 'cooldown_recent_created', message: '请稍后再开始下一次对话' });
      }
    }

    // 目标会话编号：基于“已完成”的最大编号 + 1（防止跳级）
    const db2 = createDb();
    const rowsCompleted = await db2
      .select({ n: sessions.sessionNumber })
      .from(sessions)
      .where(sql`${sessions.visitorInstanceId} = ${visitorInstanceId} AND ${sessions.finalizedAt} IS NOT NULL`)
      .orderBy(desc(sessions.sessionNumber))
      .limit(1);
    const nextNumber = ((rowsCompleted as any[])[0]?.n ?? 0) + 1;

    const useNumber = typeof sessionNumber === 'number' ? Number(sessionNumber) : nextNumber;

    // Package（homework_sets）一致性校验：学生只能在“有对应包且窗口开放”的情况下开始第 N 次会话
    try {
      const payload = (req as any).auth;
      const isStudentOrHasStudentRole = payload && (payload.role === 'student' || (Array.isArray((payload as any).roles) && (payload as any).roles.includes('student')));
      if (isStudentOrHasStudentRole) {
        const dbCheck = createDb();
        const [instRow] = await dbCheck.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
        if (!instRow) return reply.status(404).send({ error: 'visitor_instance_not_found' });
        const [uRow] = await dbCheck.select({ classId: users.classId }).from(users).where(eq(users.id as any, (instRow as any).userId));
        const clsId = (uRow as any)?.classId;
        if (clsId) {
          const [pkg] = await dbCheck.select().from(homeworkSets).where(and(eq(homeworkSets.classId as any, clsId), eq(homeworkSets.sequenceNumber as any, useNumber)));
          if (!pkg) {
            return reply.status(403).send({ error: 'forbidden', code: 'package_missing', message: '未配置本班第N次作业包，暂不可开始该轮对话' });
          }
          const now = new Date();
          const startAt = (pkg as any).studentStartAt as Date;
          const deadline = (pkg as any).studentDeadline as Date;
          if (!(now >= startAt && now <= deadline)) {
            return reply.status(403).send({ error: 'forbidden', code: 'package_window_closed', message: '当前作业包窗口未开放', startAt, deadline });
          }
        }
      }
    } catch {}
    if (auto !== false) {
      const id = await createSession({ visitorInstanceId, sessionNumber: useNumber });
      return reply.send({ sessionId: id, sessionNumber: useNumber });
    }
    const id = await createSession({ visitorInstanceId, sessionNumber: useNumber });
    return reply.send({ sessionId: id, sessionNumber: useNumber });
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
        msgCount: sql`jsonb_array_length(${sessions.chatHistory})`
      })
      .from(sessions)
      .where(eq(sessions.visitorInstanceId, visitorInstanceId))
      .orderBy(desc(sessions.sessionNumber))
      .limit(Number(pageSize))
      .offset(offset);

    const items = await Promise.all(rows.map(async (r) => {
      const messageCount = Number((r as any).msgCount || 0);

      // Check for homework submissions
      const submissionRows = await db
        .select({ id: homeworkSubmissions.id })
        .from(homeworkSubmissions)
        .where(eq(homeworkSubmissions.sessionId as any, r.id));
      let lastMessage = null;
      if (includePreview) {
        // 更安全：单条查询该会话 chat_history，并在应用层取最后一条
        const [fullRow] = await db.select({ chat: sessions.chatHistory }).from(sessions).where(eq(sessions.id, (r as any).id));
        const hist = ((fullRow as any)?.chat || []) as any[];
        if (Array.isArray(hist) && hist.length) {
          const last = hist[hist.length - 1];
          lastMessage = { speaker: (last as any).speaker, content: (last as any).content, timestamp: (last as any).timestamp } as any;
        }
      }

      return {
        sessionId: r.id,
        sessionNumber: r.n,
        createdAt: r.createdAt,
        completed: !!r.finalizedAt,
        messageCount,
        hasDiary: !!r.diary,
        hasActivity: !!r.act,
        hasThoughtRecord: submissionRows.length > 0,
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

  // 读取某个 visitor 实例的模板信息（name、templateKey、brief）
  app.get('/visitor/template', {
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

    // 授权：学生需为 owner；助教需绑定；admin 允许
    if (!payload) return reply.status(401).send({ error: 'unauthorized' });

    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
    if (!inst) return reply.status(404).send({ error: 'visitor instance not found' });

    if (payload.role === 'student' && (inst as any).userId !== payload.userId) {
      return reply.status(403).send({ error: 'forbidden' });
    }
    if (payload.role === 'assistant_tech') {
      const [bind] = await db.select().from(assistantStudents).where(eq(assistantStudents.visitorInstanceId as any, visitorInstanceId));
      if (!bind) return reply.status(403).send({ error: 'forbidden' });
    }

    const [tpl] = await db.select({ name: visitorTemplates.name, templateKey: visitorTemplates.templateKey, brief: visitorTemplates.brief })
      .from(visitorTemplates)
      .where(eq(visitorTemplates.id as any, (inst as any).templateId));
    if (!tpl) return reply.status(404).send({ error: 'template not found' });
    return reply.send({ name: (tpl as any).name, templateKey: (tpl as any).templateKey, brief: (tpl as any).brief });
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
    config: {
      rateLimit: {
        max: Number(process.env.RATELIMIT_CHAT_MESSAGE_MAX || 12),
        timeWindow: process.env.RATELIMIT_CHAT_MESSAGE_WINDOW || '1 minute',
        keyGenerator: (req: any) => (req?.auth?.userId) || req.ip,
      }
    }
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


