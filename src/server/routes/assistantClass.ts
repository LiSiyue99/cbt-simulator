import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { users, assistantStudents, sessions, visitorInstances, visitorTemplates, weeklyCompliance, homeworkSubmissions, homeworkSets, assistantChatMessages } from '../../db/schema';
import { eq, desc, and, inArray, asc } from 'drizzle-orm';
import { computeClassWeekCompliance } from '../../services/compliance';

export async function registerAssistantClassRoutes(app: FastifyInstance) {
  // 行政助教：查看自己班级学生列表
  app.get('/assistant-class/students', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const db = createDb();
    const isAdmin = ((payload as any).role === 'admin') || (((payload as any).roles || []).includes?.('admin'));
    // 支持多班授权：从JWT classScopes中挑选；若无则回退到 payload.classId（向后兼容）
    const classIds: number[] = Array.isArray((payload as any).classScopes)
      ? (payload as any).classScopes.filter((s: any) => s.role === 'assistant_class' && s.classId).map((s: any) => s.classId)
      : (payload as any).classId ? [(payload as any).classId] : [];

    let students: any[] = [];
    if (!classIds.length && !(payload as any).classId) {
      if (!isAdmin) {
        return reply.status(403).send({ error: 'forbidden' });
      }
      // Admin 无班级作用域：返回所有班级学生（抓大）
      const rows = await db.select().from(users);
      students = (rows as any[]).filter(r => r.role === 'student');
    } else {
      const cid = classIds[0] || (payload as any).classId; // 当前先选第一个班级；后续可支持查询参数切换
      const rows = await db.select().from(users).where(eq(users.classId as any, cid));
      students = (rows as any[]).filter(r => r.role === 'student');
    }

    // 补充模板、最近会话时间、总会话数
    const result = [] as any[];
    for (const s of students) {
      const vis = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (s as any).id));
      let visitorTemplateKey: string | null = null;
      let visitorTemplateName: string | null = null;
      let lastSessionAt: string | null = null;
      let totalSessions = 0;
      if (vis.length) {
        const inst = vis[0] as any;
        // 模板名称
        const vt = await db.select().from(visitorTemplates).where(eq(visitorTemplates.id as any, inst.templateId));
        if (vt.length) {
          visitorTemplateKey = (vt[0] as any).templateKey;
          visitorTemplateName = (vt[0] as any).name;
        }
        const sessRows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, inst.id)).orderBy(desc(sessions.createdAt as any));
        totalSessions = sessRows.length;
        lastSessionAt = sessRows[0] ? (sessRows[0] as any).createdAt : null;
      }
      result.push({
        studentId: (s as any).id,
        name: (s as any).name,
        email: (s as any).email,
        userId: (s as any).userId,
        visitorTemplateKey,
        visitorTemplateName,
        lastSessionAt,
        totalSessions,
      });
    }
    return reply.send({ items: result });
  });

  // 行政助教：按学生查看会话（只读）
  app.get('/assistant-class/students/:studentId/sessions', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const { studentId } = req.params as any;
    const db = createDb();

    // 验证该学生属于此行政助教的班级
    const [stu] = await db.select().from(users).where(eq(users.id as any, studentId));
    // 验证班级作用域
    const allowedClasses: number[] = Array.isArray((payload as any).classScopes)
      ? (payload as any).classScopes.filter((s: any) => s.role === 'assistant_class' && s.classId).map((s: any) => s.classId)
      : (payload as any).classId ? [(payload as any).classId] : [];
    const okClass = allowedClasses.length ? allowedClasses.includes((stu as any).classId) : (stu as any).classId === (payload as any).classId;
    if (!stu || (stu as any).role !== 'student' || !okClass) {
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

    // 选择一个授权班级进行计算；默认取第一个
    const classIds: number[] = Array.isArray((payload as any).classScopes)
      ? (payload as any).classScopes.filter((s: any) => s.role === 'assistant_class' && s.classId).map((s: any) => s.classId)
      : (payload as any).classId ? [(payload as any).classId] : [];
    const cid = classIds[0] || (payload as any).classId;
    await computeClassWeekCompliance(cid, week);

    const rows = await db.select().from(weeklyCompliance).where(eq(weeklyCompliance.classId as any, cid));
    const items = (rows as any[]).filter(r => !week || r.weekKey === week);

    // 计算 missCountUptoWeek（截止当前周为止的累计未完成次数）
    const upto = (wk: string) => wk; // 占位，直接用筛选
    const weeksUpto = (rows as any[]).filter(r => !week || r.weekKey <= week);
    const missByStudent = new Map<string, number>();
    for (const r of weeksUpto as any[]) {
      const miss = (r.hasSession === 0 || r.hasThoughtRecordByFri === 0) ? 1 : 0;
      missByStudent.set(r.studentId, (missByStudent.get(r.studentId) || 0) + miss);
    }
    const enriched = items.map((r: any) => ({ ...r, missCountUptoWeek: missByStudent.get(r.studentId) || 0 }));
    return reply.send({ items: enriched });
  });

  // 行政助教：按“第N次会话”查看完成情况（不按自然周）
  app.get('/assistant-class/progress-by-session', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const db = createDb();
    const { sessionNumber } = req.query as any;
    const sn = Number(sessionNumber);
    if (!sn || sn < 1 || Number.isNaN(sn)) {
      return reply.status(400).send({ error: 'invalid sessionNumber' });
    }

    // 本班学生
    const classIds: number[] = Array.isArray((payload as any).classScopes)
      ? (payload as any).classScopes.filter((s: any) => s.role === 'assistant_class' && s.classId).map((s: any) => s.classId)
      : (payload as any).classId ? [(payload as any).classId] : [];
    const cid = classIds[0] || (payload as any).classId;
    const rows = await db.select().from(users).where(eq(users.classId as any, cid));
    const students = (rows as any[]).filter(r => r.role === 'student');

    const items: any[] = [];
    for (const stu of students as any[]) {
      // 该学生实例
      const vis = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (stu as any).id));
      let hasSession = 0;
      let hasThoughtRecord = 0;
      let missCountUptoSession = 0;
      if (vis.length) {
        const inst = vis[0] as any;
        // 是否存在第 N 次会话
        const sRow = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, inst.id) as any).orderBy(desc(sessions.sessionNumber as any));
        const byNumber = new Map<number, any>();
        for (const r of sRow as any[]) { byNumber.set((r as any).sessionNumber, r); }

        const target = byNumber.get(sn);
        hasSession = target ? 1 : 0;
        if (target) {
          const sub = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, (target as any).id));
          hasThoughtRecord = (sub as any[]).length > 0 ? 1 : 0;
        }
        // 累计未完成：从 1..N，若缺会话或该会话无作业提交计 1
        for (let i = 1; i <= sn; i++) {
          const si = byNumber.get(i);
          if (!si) { missCountUptoSession += 1; continue; }
          const subi = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, (si as any).id));
          if (!(subi as any[]).length) missCountUptoSession += 1;
        }
      }
      items.push({ studentId: (stu as any).id, hasSession, hasThoughtRecord, missCountUptoSession });
    }
    return reply.send({ items });
  });

  // 行政助教：读取本班所有作业集（package）
  app.get('/assistant-class/homework/sets', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const db = createDb();
    const classIds: number[] = Array.isArray((payload as any).classScopes)
      ? (payload as any).classScopes.filter((s: any) => s.role === 'assistant_class' && s.classId).map((s: any) => s.classId)
      : (payload as any).classId ? [(payload as any).classId] : [];
    const cid = classIds[0] || (payload as any).classId;
    if (!cid) return reply.send({ items: [] });
    const rows = await db.select().from(homeworkSets).where(eq(homeworkSets.classId as any, cid)).orderBy(desc(homeworkSets.sequenceNumber as any));
    const items = (rows as any[]).map((r: any) => ({ id: r.id, title: r.title, description: r.description, sequenceNumber: r.sequenceNumber, studentStartAt: r.studentStartAt, studentDeadline: r.studentDeadline, assistantStartAt: r.assistantStartAt, assistantDeadline: r.assistantDeadline, status: r.status }));
    return reply.send({ items });
  });

  // 行政助教：查看某个作业集在本班的完成与反馈进度
  app.get('/assistant-class/homework/sets/:id/progress', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const db = createDb();
    const { id } = req.params as any;
    const classIds: number[] = Array.isArray((payload as any).classScopes)
      ? (payload as any).classScopes.filter((s: any) => s.role === 'assistant_class' && s.classId).map((s: any) => s.classId)
      : (payload as any).classId ? [(payload as any).classId] : [];
    const cid = classIds[0] || (payload as any).classId;
    if (!cid) return reply.send({ items: [] });

    // 读取班级学生
    const stuRows = await db.select().from(users).where(eq(users.classId as any, cid));
    const students = (stuRows as any[]).filter(r => r.role === 'student');

    // 找到该作业集的序号（与会话号对齐）
    const [setRow] = await db.select().from(homeworkSets).where(eq(homeworkSets.id as any, id));
    if (!setRow) return reply.status(404).send({ error: 'not_found' });
    const sn = (setRow as any).sequenceNumber as number;

    const items: any[] = [];
    for (const stu of students as any[]) {
      const vis = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, (stu as any).id));
      if (!(vis as any[]).length) {
        items.push({
          studentId: (stu as any).id,
          name: (stu as any).name,
          userId: (stu as any).userId,
          sessionNumber: sn,
          hasSubmission: 0,
          sessionDurationMinutes: null,
          assistantFeedback: null,
        });
        continue;
      }
      const inst = vis[0] as any;
      const sessRows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, inst.id)).orderBy(desc(sessions.sessionNumber as any));
      const byNum = new Map<number, any>();
      for (const s of sessRows as any[]) byNum.set((s as any).sessionNumber, s);
      const target = byNum.get(sn);
      if (!target) {
        items.push({
          studentId: (stu as any).id,
          name: (stu as any).name,
          userId: (stu as any).userId,
          sessionNumber: sn,
          hasSubmission: 0,
          sessionDurationMinutes: null,
          assistantFeedback: null,
        });
        continue;
      }
      const [sub] = await db.select().from(homeworkSubmissions).where(eq(homeworkSubmissions.sessionId as any, (target as any).id));
      const hasSubmission = sub ? 1 : 0;

      // 会话时长（分钟）：优先 finalizedAt - createdAt；若未完成则回退为 updatedAt - createdAt（近似）
      let sessionDurationMinutes: number | null = null;
      const createdAt = (target as any).createdAt ? new Date((target as any).createdAt).getTime() : null;
      const finalizedAt = (target as any).finalizedAt ? new Date((target as any).finalizedAt).getTime() : null;
      const updatedAt = (target as any).updatedAt ? new Date((target as any).updatedAt).getTime() : null;
      if (createdAt && finalizedAt && finalizedAt >= createdAt) {
        sessionDurationMinutes = Math.round((finalizedAt - createdAt) / 60000);
      } else if (createdAt && updatedAt && updatedAt >= createdAt) {
        sessionDurationMinutes = Math.round((updatedAt - createdAt) / 60000);
      }

      // 助教反馈内容：优先取“提交之后”的最新助教消息；若没有提交后消息，则回退为该会话中最新一条助教消息
      let assistantFeedback: string | null = null;
      const msgsDesc = await db
        .select({ content: assistantChatMessages.content, createdAt: assistantChatMessages.createdAt })
        .from(assistantChatMessages)
        .where(and(
          eq(assistantChatMessages.sessionId as any, (target as any).id),
          eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any),
        ))
        .orderBy(desc(assistantChatMessages.createdAt as any));
      if (sub) {
        for (const m of msgsDesc as any[]) {
          if (new Date((m as any).createdAt) >= new Date((sub as any).createdAt)) {
            assistantFeedback = (m as any).content as string;
            break;
          }
        }
      }
      if (!assistantFeedback && (msgsDesc as any[]).length) {
        assistantFeedback = (msgsDesc[0] as any).content as string;
      }

      items.push({
        studentId: (stu as any).id,
        name: (stu as any).name,
        userId: (stu as any).userId,
        sessionNumber: sn,
        hasSubmission,
        sessionDurationMinutes,
        assistantFeedback,
      });
    }
    return reply.send({ items });
  });

  // 行政助教：查看某作业包下，指定学生对应会话的聊天记录（分页）
  app.get('/assistant-class/homework/sets/:id/feedback', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_class', 'admin']);
    const db = createDb();
    const { id } = req.params as any;
    const { studentId, page = '1', pageSize = '50' } = (req.query || {}) as any;

    if (!studentId) return reply.status(400).send({ error: 'bad_request', message: 'missing studentId' });

    // 班级作用域校验
    const classIds: number[] = Array.isArray((payload as any).classScopes)
      ? (payload as any).classScopes.filter((s: any) => s.role === 'assistant_class' && s.classId).map((s: any) => s.classId)
      : (payload as any).classId ? [(payload as any).classId] : [];
    const cid = classIds[0] || (payload as any).classId;

    // 作业包与学生合法性
    const [setRow] = await db.select().from(homeworkSets).where(eq(homeworkSets.id as any, id));
    if (!setRow) return reply.status(404).send({ error: 'not_found' });
    if (cid && Number((setRow as any).classId) !== Number(cid)) {
      // 限定仅本班可见
      return reply.status(403).send({ error: 'forbidden' });
    }
    const [stu] = await db.select().from(users).where(eq(users.id as any, studentId));
    if (!stu) return reply.status(404).send({ error: 'student_not_found' });
    if (cid && Number((stu as any).classId) !== Number(cid)) return reply.status(403).send({ error: 'forbidden' });

    // 找到该学生此序号的会话
    const sn = (setRow as any).sequenceNumber as number;
    const vis = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, studentId));
    if (!(vis as any[]).length) return reply.send({ items: [], page: Number(page), pageSize: Number(pageSize), total: 0 });
    const inst = vis[0] as any;
    const sessRows = await db.select().from(sessions).where(eq(sessions.visitorInstanceId as any, inst.id));
    const target = (sessRows as any[]).find(r => (r as any).sessionNumber === sn);
    if (!target) return reply.send({ items: [], page: Number(page), pageSize: Number(pageSize), total: 0 });

    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(200, Math.max(1, Number(pageSize) || 50));
    const offset = (p - 1) * ps;

    // 同时返回学生与助教消息，按时间升序分页
    const rows = await db
      .select({ content: assistantChatMessages.content, createdAt: assistantChatMessages.createdAt, senderRole: assistantChatMessages.senderRole })
      .from(assistantChatMessages)
      .where(eq(assistantChatMessages.sessionId as any, (target as any).id))
      .orderBy(asc(assistantChatMessages.createdAt as any))
      .limit(ps)
      .offset(offset);

    // 估算总数（轻量做法：再查一遍 count）
    let total = rows.length;
    try {
      const all = await db.select({ createdAt: assistantChatMessages.createdAt }).from(assistantChatMessages)
        .where(eq(assistantChatMessages.sessionId as any, (target as any).id));
      total = (all as any[]).length;
    } catch {}

    return reply.send({
      items: rows.map(r => ({
        speaker: (r as any).senderRole === 'assistant_tech' ? 'assistant' : 'student',
        content: (r as any).content,
        timestamp: (r as any).createdAt,
      })),
      page: p,
      pageSize: ps,
      total,
    });
  });
}
