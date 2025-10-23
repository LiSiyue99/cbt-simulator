import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { sessions, visitorInstances, assistantStudents, assistantChatMessages, homeworkSubmissions, users, homeworkSets } from '../../db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';

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

    const roles = (payload as any)?.roles || [];
    const hasStudentRole = (payload as any).role === 'student' || (Array.isArray(roles) && roles.includes('student'));

    if (hasStudentRole) {
      const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
      if (!inst || (inst as any).userId !== payload.userId) return reply.status(403).send({ error: 'forbidden' });
    } else if (payload.role === 'assistant_tech') {
      const [bind] = await db
        .select()
        .from(assistantStudents)
        .where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, visitorInstanceId)));
      if (!bind) return reply.status(403).send({ error: 'forbidden' });
    } else if (payload.role === 'assistant_class') {
      // 行政助教兼学生：若该实例属于自己，也允许查看
      const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
      if (!inst || (inst as any).userId !== payload.userId) return reply.status(403).send({ error: 'forbidden' });
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

    // 聚合统计（避免 N+1）
    const sessionIds = (sessRows as any[]).map((r: any) => r.id);
    let submissionCounts: Record<string, number> = {};
    let chatCounts: Record<string, number> = {};
    if (sessionIds.length) {
      const subRows = await db
        .select({ sessionId: homeworkSubmissions.sessionId, cnt: sql`count(*)` })
        .from(homeworkSubmissions)
        .where(inArray(homeworkSubmissions.sessionId as any, sessionIds as any))
        .groupBy(homeworkSubmissions.sessionId as any);
      for (const r of subRows as any[]) submissionCounts[(r as any).sessionId] = Number((r as any).cnt || 0);

      const chatRows = await db
        .select({ sessionId: assistantChatMessages.sessionId, cnt: sql`count(*)` })
        .from(assistantChatMessages)
        .where(inArray(assistantChatMessages.sessionId as any, sessionIds as any))
        .groupBy(assistantChatMessages.sessionId as any);
      for (const r of chatRows as any[]) chatCounts[(r as any).sessionId] = Number((r as any).cnt || 0);
    }

    const items = (sessRows as any[]).map((s: any) => ({
      sessionId: s.id,
      sessionNumber: s.sessionNumber,
      createdAt: s.createdAt,
      homework: s.homework || [],
      thoughtRecordCount: submissionCounts[s.id] || 0,
      chatCount: chatCounts[s.id] || 0,
    }));

    return reply.send({ items });
  });

  // 学生端：按 session 读取匹配的作业集（该班第N次作业）
  app.get('/homework/sets/by-session', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const payload = (req as any).auth;
    const { sessionId } = req.query as any;
    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
    if (!inst) return reply.status(404).send({ error: 'visitor instance not found' });
    const [stu] = await db.select({ id: users.id, classId: users.classId }).from(users).where(eq(users.id as any, (inst as any).userId));
    if (!stu) return reply.status(404).send({ error: 'student not found' });
    // 授权：学生必须是 owner；助教需绑定；admin 放行
    if (payload?.role === 'student' && payload.userId !== (inst as any).userId) return reply.status(403).send({ error: 'forbidden' });
    if (payload?.role === 'assistant_tech') {
      const [bind] = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, (inst as any).id)));
      if (!bind) return reply.status(403).send({ error: 'forbidden' });
    }

    const [setRow] = await db.select().from(homeworkSets)
      .where(and(eq(homeworkSets.classId as any, (stu as any).classId), eq(homeworkSets.sequenceNumber as any, (s as any).sessionNumber)))
      .orderBy(desc(homeworkSets.updatedAt as any));
    if (!setRow) return reply.send({ item: null });
    return reply.send({ item: setRow });
  });

  // 学生端：提交或更新作业（窗口校验）
  app.post('/homework/submissions', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId','homeworkSetId','formData'],
        properties: {
          sessionId: { type: 'string' },
          homeworkSetId: { type: 'string' },
          formData: { type: 'object' },
        },
      },
    },
    config: {
      rateLimit: {
        max: Number(process.env.RATELIMIT_HOMEWORK_SUBMIT_MAX || 4),
        timeWindow: process.env.RATELIMIT_HOMEWORK_SUBMIT_WINDOW || '1 minute',
        keyGenerator: (req: any) => (req?.auth?.userId) || req.ip,
      }
    }
  }, async (req, reply) => {
    const db = createDb();
    const payload = (req as any).auth;
    const { sessionId, homeworkSetId, formData } = (req.body || {}) as any;
    // 拥有权校验
    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
    if (!inst) return reply.status(404).send({ error: 'visitor instance not found' });
    if (!payload || payload.role !== 'student' || payload.userId !== (inst as any).userId) return reply.status(403).send({ error: 'forbidden' });

    // 匹配作业集并校验窗口
    const [setRow] = await db.select().from(homeworkSets).where(eq(homeworkSets.id as any, homeworkSetId));
    if (!setRow) return reply.status(404).send({ error: 'homework_set_not_found' });
    const now = new Date();
    if (!(now >= (setRow as any).studentStartAt && now <= (setRow as any).studentDeadline)) {
      return reply.status(403).send({ error: 'forbidden', code: 'student_window_closed' });
    }

    // 字段必填校验（所有字段均必填）
    const fields = ((setRow as any).formFields || []) as any[];
    for (const f of fields) {
      if (!(f.key in (formData || {}))) return reply.status(400).send({ error: 'bad_request', message: `missing field ${f.key}` });
      const v = (formData || {})[f.key];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
        return reply.status(400).send({ error: 'bad_request', message: `empty field ${f.key}` });
      }
    }

    // 单次提交：若该 session 已存在提交，直接返回 409 冲突
    const exists = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, sessionId));
    const item = {
      homeworkSetId,
      sessionId,
      studentId: (inst as any).userId,
      formData,
      updatedAt: new Date(),
    } as any;
    if ((exists as any[]).length) {
      return reply.status(409).send({ error: 'conflict', code: 'submission_exists' });
    }
    const id = crypto.randomUUID();
    await db.insert(homeworkSubmissions).values({ id, ...item, createdAt: new Date() } as any);
    return reply.send({ ok: true, id, updated: false });
  });

  // 学生端：按 session 读取自己的提交
  app.get('/homework/submissions', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const payload = (req as any).auth;
    const { sessionId } = (req.query || {}) as any;
    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
    if (!inst) return reply.status(404).send({ error: 'visitor instance not found' });
    if (!payload || payload.role !== 'student' || payload.userId !== (inst as any).userId) return reply.status(403).send({ error: 'forbidden' });
    const [row] = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, sessionId));
    return reply.send({ item: row || null });
  });

  // 学生端：修改已存在的作业提交（窗口内允许），并提醒助教
  app.put('/homework/submissions', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId','formData'],
        properties: {
          sessionId: { type: 'string' },
          formData: { type: 'object' },
        },
      },
    },
    config: {
      rateLimit: {
        max: Number(process.env.RATELIMIT_HOMEWORK_UPDATE_MAX || 6),
        timeWindow: process.env.RATELIMIT_HOMEWORK_UPDATE_WINDOW || '1 minute',
        keyGenerator: (req: any) => (req?.auth?.userId) || req.ip,
      }
    }
  }, async (req, reply) => {
    const db = createDb();
    const payload = (req as any).auth;
    const { sessionId, formData } = (req.body || {}) as any;

    // 拥有权校验
    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
    if (!inst) return reply.status(404).send({ error: 'visitor instance not found' });
    if (!payload || payload.role !== 'student' || payload.userId !== (inst as any).userId) return reply.status(403).send({ error: 'forbidden' });

    // 定位对应的作业集（用于窗口与字段校验）
    const [stu] = await db.select({ id: users.id, classId: users.classId }).from(users).where(eq(users.id as any, (inst as any).userId));
    const [setRow] = await db.select().from(homeworkSets)
      .where(and(eq(homeworkSets.classId as any, (stu as any).classId), eq(homeworkSets.sequenceNumber as any, (s as any).sessionNumber)))
      .orderBy(desc(homeworkSets.updatedAt as any));
    if (!setRow) return reply.status(403).send({ error: 'forbidden', code: 'package_missing' });
    const now = new Date();
    if (!(now >= (setRow as any).studentStartAt && now <= (setRow as any).studentDeadline)) {
      return reply.status(403).send({ error: 'forbidden', code: 'package_window_closed' });
    }

    // 字段必填校验
    const fields = ((setRow as any).formFields || []) as any[];
    for (const f of fields) {
      if (!(f.key in (formData || {}))) return reply.status(400).send({ error: 'bad_request', message: `missing field ${f.key}` });
      const v = (formData || {})[f.key];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
        return reply.status(400).send({ error: 'bad_request', message: `empty field ${f.key}` });
      }
    }

    const [sub] = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, sessionId));
    if (!sub) return reply.status(404).send({ error: 'submission_not_found' });

    await db.update(homeworkSubmissions)
      .set({ formData: formData as any, updatedAt: new Date() } as any)
      .where(eq(homeworkSubmissions.sessionId as any, sessionId));

    // 助教提醒：插入一条未读消息（统一走 assistant chat 通道）
    try {
      const msg = `学生更新了作业提交（第${(s as any).sessionNumber}次）`;
      await db.insert(assistantChatMessages).values({
        id: crypto.randomUUID(),
        sessionId,
        senderRole: 'student' as any,
        senderId: (inst as any).userId,
        content: msg,
        createdAt: new Date(),
      } as any);
    } catch {}

    return reply.send({ ok: true, id: (sub as any).id, updated: true });
  });

  // Dashboard 待办事项接口
  app.get('/dashboard/todos', {
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

    // 授权检查：学生或“具备学生授权/行政助教（学生视角）”均可
    const roles = (payload as any)?.roles || [];
    const hasStudentRole = (payload as any)?.role === 'student' || (Array.isArray(roles) && roles.includes('student'));
    if (!payload || (!hasStudentRole && (payload as any).role !== 'assistant_class')) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
    if (!inst || (inst as any).userId !== payload.userId) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    // 学生所在班级（用于匹配作业包）
    const [stuRow] = await db.select({ classId: users.classId }).from(users).where(eq(users.id as any, (inst as any).userId));

    // 获取所有会话
    const sessRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.visitorInstanceId as any, visitorInstanceId))
      .orderBy(desc(sessions.sessionNumber as any));

    const todos = [] as any[];
    let sessionsCompleted = 0;
    let thoughtRecordsCompleted = 0;
    let unreadMessageCount = 0;

    // 检查是否有进行中的会话（未finalized）
    const currentSession = (sessRows as any[]).find(s => !s.finalizedAt);
    const completedSessions = (sessRows as any[]).filter(s => s.finalizedAt);
    sessionsCompleted = completedSessions.length;

    // 本周是否需要开始新对话（仅当存在下一次作业包时才引导）
    const now = new Date();
    const thisWeek = getWeekKey(now);
    const hasThisWeekSession = (sessRows as any[]).some(s => {
      const sessionWeek = getWeekKey(new Date(s.createdAt));
      return sessionWeek === thisWeek;
    });

    if (!hasThisWeekSession && !currentSession) {
      // 下一次会话序号
      const maxNumber = (sessRows as any[]).reduce((m, r) => Math.max(m, Number((r as any).sessionNumber || 0)), 0);
      const nextSeq = maxNumber + 1;
      let dueFromPackage: Date | null = null;
      if ((stuRow as any)?.classId != null) {
        const [pkg] = await db.select({ studentDeadline: homeworkSets.studentDeadline }).from(homeworkSets)
          .where(and(
            eq(homeworkSets.classId as any, (stuRow as any).classId),
            eq(homeworkSets.sequenceNumber as any, nextSeq)
          ))
          .orderBy(desc(homeworkSets.updatedAt as any));
        if (pkg) {
          dueFromPackage = (pkg as any).studentDeadline as Date;
        }
      }
      if (dueFromPackage) {
        todos.push({
          id: 'session-weekly',
          type: 'session',
          title: '完成本周AI访客对话',
          description: '还未开始本周的CBT对话训练',
          completed: false,
          urgent: (dueFromPackage as Date) < now,
          dueDate: (dueFromPackage as Date).toISOString(),
          action: {
            type: 'navigate',
            target: '/dashboard/conversation'
          }
        });
      }
    }

    // 检查每个已完成会话的作业提交情况（仅当存在对应作业包时）
    for (const session of completedSessions) {
      const sessionId = session.id;
      const tr = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, sessionId));

      // 查找班级该次序的作业包
      let setDeadline: Date | null = null;
      if ((stuRow as any)?.classId != null) {
        const [setRow] = await db.select({ studentDeadline: homeworkSets.studentDeadline }).from(homeworkSets)
          .where(and(
            eq(homeworkSets.classId as any, (stuRow as any).classId),
            eq(homeworkSets.sequenceNumber as any, (session as any).sessionNumber)
          ))
          .orderBy(desc(homeworkSets.updatedAt as any));
        if (setRow) setDeadline = (setRow as any).studentDeadline as Date;
      }

      if (tr.length === 0 && setDeadline) {
        const dueDate = new Date(setDeadline);
        todos.push({
          id: `assignment-${sessionId}`,
          type: 'assignment',
          title: `填写第${session.sessionNumber}次作业`,
          description: '分析对话中的情境、想法和情绪反应',
          completed: false,
          urgent: dueDate < now,
          dueDate: dueDate.toISOString(),
          sessionId: sessionId,
          action: {
            type: 'navigate',
            target: '/dashboard/assignments',
            params: { sessionId }
          }
        });
      } else if (tr.length > 0) {
        thoughtRecordsCompleted++;
      }
    }

    // 检查未读的助教消息（聊天）
    for (const session of sessRows as any[]) {
      const sessionId = session.id;
      try {
        const rows = await db.select()
          .from(assistantChatMessages)
          .where(and(
            eq(assistantChatMessages.sessionId as any, sessionId),
            eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any),
            eq(assistantChatMessages.status as any, 'unread' as any)
          ));
        if (rows.length > 0) unreadMessageCount += rows.length;
      } catch {
        // 兼容本地数据库尚未创建该表的情况：跳过统计，避免 500
        // 待运行迁移后将自动启用未读计数
        continue;
      }
    }

    if (unreadMessageCount > 0) {
      todos.push({
        id: 'messages-unread',
        type: 'message',
        title: '查看助教新消息',
        description: `你有 ${unreadMessageCount} 条未读消息`,
        completed: false,
        urgent: false,
        unreadCount: unreadMessageCount,
        action: {
          type: 'navigate',
          target: '/dashboard/assignments'
        }
      });
    }

    const summary = {
      totalTodos: todos.length,
      urgentTodos: todos.filter(t => t.urgent).length,
      completedThisWeek: hasThisWeekSession ? 1 : 0,
      weeklyProgress: {
        sessionsCompleted: hasThisWeekSession ? 1 : 0,
        sessionsRequired: 1,
        thoughtRecordsCompleted,
        thoughtRecordsRequired: Math.max(completedSessions.length, 1)
      }
    };

    return reply.send({ items: todos, summary });
  });
}

// 辅助函数：获取周次标识 (YYYY-WW)
function getWeekKey(date: Date): string {
  const year = date.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
  return `${year}-${weekNumber.toString().padStart(2, '0')}`;
}

// 辅助函数：获取本周结束时间
function getWeekEndDate(date: Date): Date {
  const endOfWeek = new Date(date);
  const day = endOfWeek.getDay();
  const diff = 6 - day; // 周六
  endOfWeek.setDate(endOfWeek.getDate() + diff);
  endOfWeek.setHours(23, 59, 59, 999);
  return endOfWeek;
}
