import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { sessions, visitorInstances, assistantStudents, thoughtRecords, assistantChatMessages } from '../../db/schema';
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

    // 聚合统计（避免 N+1）
    const sessionIds = (sessRows as any[]).map((r: any) => r.id);
    let trCounts: Record<string, number> = {};
    let chatCounts: Record<string, number> = {};
    if (sessionIds.length) {
      const trRows = await db
        .select({ sessionId: thoughtRecords.sessionId, cnt: sql`count(*)` })
        .from(thoughtRecords)
        .where(inArray(thoughtRecords.sessionId as any, sessionIds as any))
        .groupBy(thoughtRecords.sessionId as any);
      for (const r of trRows as any[]) trCounts[(r as any).sessionId] = Number((r as any).cnt || 0);

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
      thoughtRecordCount: trCounts[s.id] || 0,
      chatCount: chatCounts[s.id] || 0,
    }));

    return reply.send({ items });
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

    // 授权检查：只有学生可以访问自己的待办事项
    if (!payload || payload.role !== 'student') {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
    if (!inst || (inst as any).userId !== payload.userId) {
      return reply.status(403).send({ error: 'forbidden' });
    }

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

    // 本周是否需要开始新对话
    const now = new Date();
    const thisWeek = getWeekKey(now);
    const hasThisWeekSession = (sessRows as any[]).some(s => {
      const sessionWeek = getWeekKey(new Date(s.createdAt));
      return sessionWeek === thisWeek;
    });

    if (!hasThisWeekSession && !currentSession) {
      todos.push({
        id: 'session-weekly',
        type: 'session',
        title: '完成本周AI访客对话',
        description: '还未开始本周的CBT对话训练',
        completed: false,
        urgent: true,
        dueDate: getWeekEndDate(now).toISOString(),
        action: {
          type: 'navigate',
          target: '/dashboard/conversation'
        }
      });
    }

    // 检查每个已完成会话的三联表填写情况
    for (const session of completedSessions) {
      const sessionId = session.id;
      const tr = await db.select().from(thoughtRecords).where(eq(thoughtRecords.sessionId as any, sessionId));

      if (tr.length === 0) {
        const dueDate = new Date(session.finalizedAt);
        dueDate.setDate(dueDate.getDate() + 7); // 会话结束后7天内填写

        todos.push({
          id: `assignment-${sessionId}`,
          type: 'assignment',
          title: `填写第${session.sessionNumber}次对话的三联表`,
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
      } else {
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
