import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { assistantStudents, users, sessions, longTermMemoryVersions, visitorInstances, thoughtRecords, visitorTemplates, whitelistEmails, assistantChatMessages } from '../../db/schema';
import { eq, desc, and, sql, isNull, inArray } from 'drizzle-orm';

export async function registerAssistantRoutes(app: FastifyInstance) {
  // Admin 概览（KPI 聚合，不含学生明细）
  app.get('/admin/overview', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();

    // 计算本周时间窗
    const now = new Date();
    const dow = now.getDay();
    const daysSinceMonday = dow === 0 ? 6 : dow - 1;
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(now.getDate() - daysSinceMonday);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    // 1) 本周会话数
    const sessionsThisWeekRows = await db.select({ count: sql`count(*)` })
      .from(sessions)
      .where(and(
        sql`${sessions.createdAt} >= ${weekStart}`,
        sql`${sessions.createdAt} < ${weekEnd}`
      ));
    const sessionsThisWeek = Number((sessionsThisWeekRows[0] as any)?.count || 0);

    // 2) 三联表提交率
    const finalizedRows = await db.select({ id: sessions.id })
      .from(sessions)
      .where(and(
        sql`${sessions.finalizedAt} >= ${weekStart}`,
        sql`${sessions.finalizedAt} < ${weekEnd}`
      ));
    const finalizedIds = (finalizedRows as any[]).map(r => r.id);
    let trSubmitRate = 0;
    if (finalizedIds.length > 0) {
      const trRows = await db.select({ sessionId: thoughtRecords.sessionId }).from(thoughtRecords).where(inArray(thoughtRecords.sessionId as any, finalizedIds as any));
      const submitted = new Set((trRows as any[]).map(r => r.sessionId)).size;
      trSubmitRate = finalizedIds.length > 0 ? submitted / finalizedIds.length : 0;
    }

    // 3) 助教反馈达标率（助教在本周对该学生任一会话发送≥1条）
    // 近似：以 finalizedIds 的集合对应的会话维度为基数，只要该会话中存在本周助教消息则视作达标
    let taFeedbackRate = 0;
    if (finalizedIds.length > 0) {
      const msgRows = await db.select({ sessionId: assistantChatMessages.sessionId })
        .from(assistantChatMessages)
        .where(and(
          inArray(assistantChatMessages.sessionId as any, finalizedIds as any),
          eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any),
          sql`${assistantChatMessages.createdAt} >= ${weekStart}`,
          sql`${assistantChatMessages.createdAt} < ${weekEnd}`
        ));
      const covered = new Set((msgRows as any[]).map(r => r.sessionId)).size;
      taFeedbackRate = finalizedIds.length > 0 ? covered / finalizedIds.length : 0;
    }

    // 4) 模板覆盖度：各班是否 10/10 覆盖
    // 班级→学生→实例的模板Key 分布（按 users.classId、visitorInstances.templateId）
    const userRows = await db.select({ id: users.id, classId: users.classId }).from(users).where(and(
      eq(users.role as any, 'student' as any),
      sql`${users.status} = 'active'`
    ));
    const byClassStudents = new Map<number, string[]>();
    for (const u of userRows as any[]) {
      if (!u.classId) continue;
      const arr = byClassStudents.get(u.classId) || [];
      arr.push(u.id);
      byClassStudents.set(u.classId, arr);
    }
    const templatesAll = await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey }).from(visitorTemplates);
    const templateKeySet = new Set((templatesAll as any[]).map(t => t.templateKey));
    const templateKeyById = new Map<string, string>();
    for (const t of templatesAll as any[]) templateKeyById.set((t as any).id, (t as any).templateKey);
    const coverageByClass: Record<string, number> = {};
    const coverageMatrix: Record<string, Record<string, number>> = {};
    for (const [classId, stuIds] of byClassStudents.entries()) {
      if (stuIds.length === 0) { coverageByClass[String(classId)] = 0; continue; }
      const inst = await db.select({ userId: visitorInstances.userId, templateId: visitorInstances.templateId })
        .from(visitorInstances)
        .where(inArray(visitorInstances.userId as any, stuIds as any));
      const tplIds = new Set((inst as any[]).map(r => r.templateId));
      // map templateId → templateKey
      const tplKeys = new Set<string>();
      const perTemplateCount: Record<string, number> = {};
      for (const t of templatesAll as any[]) if (tplIds.has(t.id)) tplKeys.add(t.templateKey);
      // 统计每个模板在该班的人数
      for (const row of inst as any[]) {
        const temp = (templatesAll as any[]).find(t => t.id === row.templateId);
        if (!temp) continue;
        perTemplateCount[temp.templateKey] = (perTemplateCount[temp.templateKey] || 0) + 1;
      }
      coverageMatrix[String(classId)] = perTemplateCount;
      const ratio = templateKeySet.size > 0 ? tplKeys.size / templateKeySet.size : 0;
      coverageByClass[String(classId)] = ratio;
    }

    // 未读与待批改按助教聚合（摘要）
    const bindingsAll = await db.select().from(assistantStudents);
    const instanceToAssistant = new Map<string, string>();
    const assistantIds = new Set<string>();
    for (const b of bindingsAll as any[]) { instanceToAssistant.set(b.visitorInstanceId, b.assistantId); assistantIds.add(b.assistantId); }
    const assistantUsers = assistantIds.size ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id as any, Array.from(assistantIds) as any)) : [];
    const assistantNameById = new Map<string, string>();
    for (const u of assistantUsers as any[]) assistantNameById.set(u.id, u.name || '助教');

    // 助教模板工作量：每名助教→模板Key→学生数
    const bindingInstanceIds = Array.from(instanceToAssistant.keys());
    const instanceTplRows = bindingInstanceIds.length ? await db.select({ id: visitorInstances.id, templateId: visitorInstances.templateId }).from(visitorInstances).where(inArray(visitorInstances.id as any, bindingInstanceIds as any)) : [];
    const instanceToTplKey = new Map<string, string>();
    for (const r of instanceTplRows as any[]) {
      const tplKey = templateKeyById.get((r as any).templateId);
      if (tplKey) instanceToTplKey.set((r as any).id, tplKey);
    }
    const workloadMap = new Map<string, Map<string, number>>();
    for (const b of bindingsAll as any[]) {
      const aid = b.assistantId as string;
      const tplKey = instanceToTplKey.get((b as any).visitorInstanceId);
      if (!tplKey) continue;
      if (!workloadMap.has(aid)) workloadMap.set(aid, new Map());
      const m = workloadMap.get(aid)!;
      m.set(tplKey, (m.get(tplKey) || 0) + 1);
    }
    const assistantTemplateWorkload = Array.from(workloadMap.entries()).map(([assistantId, m]) => ({
      assistantId,
      assistantName: assistantNameById.get(assistantId) || '助教',
      total: Array.from(m.values()).reduce((a,b)=>a+b,0),
      items: Array.from(m.entries()).map(([templateKey, count]) => ({ templateKey, count })).sort((a,b)=> Number(a.templateKey.replace(/\D/g,'')) - Number(b.templateKey.replace(/\D/g,'')))
    })).sort((a,b)=>b.total-a.total);

    // unread by assistant
    const allSessionsRows = await db.select({ id: sessions.id, visitorInstanceId: sessions.visitorInstanceId }).from(sessions);
    const sessionToAssistant = new Map<string, string>();
    for (const s of allSessionsRows as any[]) {
      const aid = instanceToAssistant.get((s as any).visitorInstanceId);
      if (aid) sessionToAssistant.set((s as any).id, aid);
    }
    const unreadMsgs = await db.select({ sessionId: assistantChatMessages.sessionId })
      .from(assistantChatMessages)
      .where(and(
        eq(assistantChatMessages.senderRole as any, 'student' as any),
        eq(assistantChatMessages.status as any, 'unread' as any)
      ));
    const unreadByAssistantMap = new Map<string, number>();
    for (const m of unreadMsgs as any[]) {
      const aid = sessionToAssistant.get((m as any).sessionId);
      if (!aid) continue;
      unreadByAssistantMap.set(aid, (unreadByAssistantMap.get(aid) || 0) + 1);
    }
    const unreadByAssistant = Array.from(unreadByAssistantMap.entries()).map(([assistantId, count]) => ({ assistantId, assistantName: assistantNameById.get(assistantId) || '助教', count })).sort((a,b)=>b.count-a.count);

    // pending by assistant（有TR但TR后无助教消息）
    const trRows = await db.select({ sessionId: thoughtRecords.sessionId, createdAt: thoughtRecords.createdAt }).from(thoughtRecords);
    const trTimeBySession = new Map<string, Date>();
    for (const r of trRows as any[]) trTimeBySession.set((r as any).sessionId, new Date((r as any).createdAt));
    const assistantMsgs = await db.select({ sessionId: assistantChatMessages.sessionId, createdAt: assistantChatMessages.createdAt })
      .from(assistantChatMessages)
      .where(eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any));
    const repliedAfterTr = new Set<string>();
    for (const r of assistantMsgs as any[]) {
      const sid = (r as any).sessionId;
      const trAt = trTimeBySession.get(sid);
      if (trAt && new Date((r as any).createdAt) >= trAt) repliedAfterTr.add(sid);
    }
    const pendingByAssistantMap = new Map<string, number>();
    for (const [sid, trAt] of trTimeBySession.entries()) {
      if (repliedAfterTr.has(sid)) continue;
      const aid = sessionToAssistant.get(sid);
      if (!aid) continue;
      pendingByAssistantMap.set(aid, (pendingByAssistantMap.get(aid) || 0) + 1);
    }
    const pendingByAssistant = Array.from(pendingByAssistantMap.entries()).map(([assistantId, count]) => ({ assistantId, assistantName: assistantNameById.get(assistantId) || '助教', count })).sort((a,b)=>b.count-a.count);

    // 异常提示（阈值可后续配置）
    const alerts: { type: string; message: string }[] = [];
    for (const [cid, ratio] of Object.entries(coverageByClass)) {
      if (ratio < 1) { alerts.push({ type: 'coverage', message: `班级${cid} 模板覆盖未达100%` }); }
    }
    const UNREAD_THRESHOLD = 50;
    const PENDING_THRESHOLD = 10;
    if (unreadByAssistant[0] && unreadByAssistant[0].count >= UNREAD_THRESHOLD) alerts.push({ type: 'unread', message: `助教未读消息积压最高：${unreadByAssistant[0].assistantName} ${unreadByAssistant[0].count} 条` });
    if (pendingByAssistant[0] && pendingByAssistant[0].count >= PENDING_THRESHOLD) alerts.push({ type: 'pending', message: `待批改三联表积压最高：${pendingByAssistant[0].assistantName} ${pendingByAssistant[0].count} 份` });

    return reply.send({
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      sessionsThisWeek,
      trSubmitRate,
      taFeedbackRate,
      coverageByClass,
      coverageMatrix,
      coverageDetails: Object.fromEntries(Array.from(byClassStudents.keys()).map(cid => {
        const stuIds = byClassStudents.get(cid as any) || [];
        return [String(cid), { classId: cid, className: `班级 ${cid}`, templatesTotal: templateKeySet.size, templatesCovered: Math.round((coverageByClass[String(cid)]||0)*templateKeySet.size) }];
      })),
      unreadByAssistant,
      pendingByAssistant,
      assistantTemplateWorkload,
      alerts,
    });
  });
  // 当前助教负责的 visitor 实例概览
  app.get('/assistant/visitors', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const rows = await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, payload.userId));
    const byInstance: Record<string, { visitorInstanceId: string; studentCount: number; visitorName?: string; templateKey?: string }> = {};

    for (const r of rows as any[]) {
      if (!byInstance[r.visitorInstanceId]) {
        byInstance[r.visitorInstanceId] = {
          visitorInstanceId: r.visitorInstanceId,
          studentCount: 0
        };
      }
      byInstance[r.visitorInstanceId].studentCount += 1;
    }

    // 获取每个访客实例的模板信息
    const instanceIds = Object.keys(byInstance);
    for (const instanceId of instanceIds) {
      const [instance] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, instanceId));
      if (instance) {
        const [template] = await db.select({
          name: visitorTemplates.name,
          templateKey: visitorTemplates.templateKey,
        }).from(visitorTemplates).where(eq(visitorTemplates.id as any, (instance as any).templateId));

        if (template) {
          byInstance[instanceId].visitorName = template.name;
          byInstance[instanceId].templateKey = template.templateKey;
        }
      }
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
      result.push({ studentId: r.studentId, studentEmail: u?.email, studentName: u?.name, userId: u?.userId, sessionCount: sess.length, lastSessionAt: sess[0]?.createdAt || null });
    }
    return reply.send({ items: result });
  });

  // 获取助教负责的所有学生（跨visitor）
  app.get('/assistant/all-students', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();

    // 获取该助教负责的所有学生绑定
    const rows = await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, payload.userId));

    const result = [] as any[];
    const processedStudents = new Set<string>(); // 避免重复学生

    for (const r of rows as any[]) {
      if (processedStudents.has(r.studentId)) continue; // 跳过已处理的学生
      processedStudents.add(r.studentId);

      const [u] = await db.select().from(users).where(eq(users.id as any, r.studentId));
      if (!u) continue;

      // 统计该学生在所有访客实例下的会话总数
      const studentBindings = await db.select().from(assistantStudents).where(and(
        eq(assistantStudents.assistantId as any, payload.userId),
        eq(assistantStudents.studentId as any, r.studentId)
      ));

      let totalSessions = 0;
      let lastSessionAt: Date | null = null;

      for (const binding of studentBindings) {
        const sess = await db.select().from(sessions)
          .where(eq(sessions.visitorInstanceId as any, binding.visitorInstanceId))
          .orderBy(desc(sessions.createdAt as any));

        totalSessions += sess.length;

        if (sess.length > 0 && sess[0].createdAt) {
          const sessionDate = new Date(sess[0].createdAt);
          if (!lastSessionAt || sessionDate > lastSessionAt) {
            lastSessionAt = sessionDate;
          }
        }
      }

      result.push({
        studentId: r.studentId,
        studentEmail: u.email,
        studentName: u.name,
        userId: u.userId,
        sessionCount: totalSessions,
        lastSessionAt: lastSessionAt ? lastSessionAt.toISOString() : null,
        visitorInstanceId: r.visitorInstanceId // 保留第一个遇到的实例ID，用于兼容
      });
    }

    return reply.send({ items: result });
  });

  // 根据 studentId 获取单个学生简要信息（避免前端请求全量）
  app.get('/assistant/students/:studentId/brief', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const { studentId } = req.params as any;

    // 校验助教是否与该学生有绑定
    const binds = await db.select().from(assistantStudents).where(and(
      eq(assistantStudents.assistantId as any, payload.userId),
      eq(assistantStudents.studentId as any, studentId)
    ));
    if (!binds.length) return reply.status(403).send({ error: 'forbidden' });

    const [u] = await db.select().from(users).where(eq(users.id as any, studentId));
    if (!u) return reply.status(404).send({ error: 'student not found' });

    // 聚合该学生的所有实例，统计总会话与最近时间
    let totalSessions = 0;
    let lastSessionAt: Date | null = null;
    let firstInstanceId: string | null = null;
    for (const b of binds as any[]) {
      const sess = await db.select().from(sessions)
        .where(eq(sessions.visitorInstanceId as any, b.visitorInstanceId))
        .orderBy(desc(sessions.createdAt as any));
      if (!firstInstanceId) firstInstanceId = b.visitorInstanceId;
      totalSessions += sess.length;
      if (sess.length > 0 && sess[0].createdAt) {
        const d = new Date(sess[0].createdAt as any);
        if (!lastSessionAt || d > lastSessionAt) lastSessionAt = d;
      }
    }

    return reply.send({
      studentId,
      studentEmail: (u as any).email,
      studentName: (u as any).name,
      userId: (u as any).userId,
      sessionCount: totalSessions,
      lastSessionAt: lastSessionAt ? lastSessionAt.toISOString() : null,
      visitorInstanceId: firstInstanceId,
    });
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

  // 技术助教仪表板统计数据
  app.get('/assistant/dashboard-stats', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();

    // 获取该助教负责的所有学生
    const studentBindings = await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, payload.userId));
    const studentIds = studentBindings.map((binding: any) => binding.studentId);

    if (studentIds.length === 0) {
      return reply.send({
        totalStudents: 0,
        pendingThoughtRecords: 0,
        completedFeedbacks: 0,
        weeklyDeadline: null
      });
    }

    // 获取所有学生的访客实例
    const instances = await db.select()
      .from(visitorInstances)
      .where(inArray(visitorInstances.userId as any, studentIds as any));

    const instanceIds = instances.map((instance: any) => instance.id);

    if (instanceIds.length === 0) {
      return reply.send({
        totalStudents: studentIds.length,
        pendingThoughtRecords: 0,
        completedFeedbacks: 0,
        weeklyDeadline: null
      });
    }

    // 获取所有相关会话
    const allSessions = await db.select()
      .from(sessions)
      .where(inArray(sessions.visitorInstanceId as any, instanceIds as any))
      .orderBy(desc(sessions.createdAt));

    const sessionIds = allSessions.map((session: any) => session.id);

    if (sessionIds.length === 0) {
      return reply.send({
        totalStudents: studentIds.length,
        pendingThoughtRecords: 0,
        completedFeedbacks: 0,
        weeklyDeadline: null
      });
    }

    // 统计待批改的三联表：有三联表，但三联表之后尚无助教聊天回复
    const completedSessions = (allSessions as any[]).filter((s) => s.finalizedAt);
    const completedSessionIds = completedSessions.map((s: any) => s.id);
    let pendingThoughtRecords = 0;

    if (completedSessionIds.length > 0) {
      const trs = await db.select({ sessionId: thoughtRecords.sessionId, createdAt: thoughtRecords.createdAt })
        .from(thoughtRecords)
        .where(inArray(thoughtRecords.sessionId as any, completedSessionIds as any));
      const trCreatedAtBySession = new Map<string, Date>();
      for (const tr of trs as any[]) trCreatedAtBySession.set(tr.sessionId, new Date(tr.createdAt));

      const sessionsWithTr = [...trCreatedAtBySession.keys()];
      if (sessionsWithTr.length > 0) {
        const msgs = await db.select({ sessionId: assistantChatMessages.sessionId, createdAt: assistantChatMessages.createdAt, senderRole: assistantChatMessages.senderRole })
          .from(assistantChatMessages)
          .where(and(
            inArray(assistantChatMessages.sessionId as any, sessionsWithTr as any),
            eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any)
          ));
        const hasReplyAfterTr = new Set<string>();
        for (const m of msgs as any[]) {
          const trAt = trCreatedAtBySession.get(m.sessionId!);
          if (!trAt) continue;
          if (new Date(m.createdAt) >= trAt) {
            hasReplyAfterTr.add(m.sessionId!);
          }
        }
        pendingThoughtRecords = sessionsWithTr.filter(id => !hasReplyAfterTr.has(id)).length;
      } else {
        pendingThoughtRecords = 0;
      }
    }

    // 已完成反馈数量：统计本周助教发送的聊天条数（视为反馈数）
    // 计算本周一 00:00（北京时间）的开始
    const now = new Date();
    const local = new Date(now.getTime());
    // 以当前时区计算周一，0=Sunday
    const dow = local.getDay();
    const daysSinceMonday = dow === 0 ? 6 : dow - 1;
    const weekStart = new Date(local);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(local.getDate() - daysSinceMonday);

    let completedFeedbacks = [{ count: 0 }];
    try {
      if (sessionIds.length > 0) {
        const rows = await db.select({ count: sql`count(*)` })
          .from(assistantChatMessages)
          .where(and(
            inArray(assistantChatMessages.sessionId as any, sessionIds as any),
            eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any),
            sql`${assistantChatMessages.createdAt} >= ${weekStart}`
          ));
        completedFeedbacks = rows as any;
      }
    } catch {
      completedFeedbacks = [{ count: 0 }];
    }

    // 未读消息：学生发给该助教负责学生的、状态为unread的消息
    let unreadMessages = 0;
    try {
      if (sessionIds.length > 0) {
        const unreadRows = await db.select({ count: sql`count(*)` })
          .from(assistantChatMessages)
      .where(and(
            inArray(assistantChatMessages.sessionId as any, sessionIds as any),
            eq(assistantChatMessages.senderRole as any, 'student' as any),
            eq(assistantChatMessages.status as any, 'unread' as any)
          ));
        unreadMessages = Number((unreadRows[0] as any)?.count || 0);
      } else {
        unreadMessages = 0;
      }
    } catch {
      unreadMessages = 0;
    }

    // 计算本周的截止时间（周日24:00）
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const daysUntilSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
    const weeklyDeadline = new Date(now);
    weeklyDeadline.setDate(now.getDate() + daysUntilSunday);
    weeklyDeadline.setHours(23, 59, 59, 999);

    return reply.send({
      totalStudents: studentIds.length,
      pendingThoughtRecords,
      completedFeedbacks: Number(completedFeedbacks[0]?.count || 0),
      weeklyDeadline: weeklyDeadline.toISOString(),
      unreadMessages
    });
  });

  // 未读消息会话列表：学生发来的未读消息分组，供助教跳转
  app.get('/assistant/unread-message-sessions', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();

    // 绑定与会话
    const bindings = await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, payload.userId));
    if ((bindings as any[]).length === 0) return reply.send({ items: [] });
    const instanceIds = (bindings as any[]).map(b => b.visitorInstanceId);
    const sessRows = await db.select({ id: sessions.id, visitorInstanceId: sessions.visitorInstanceId, sessionNumber: sessions.sessionNumber, createdAt: sessions.createdAt })
      .from(sessions)
      .where(inArray(sessions.visitorInstanceId as any, instanceIds as any));
    const sessionIds = (sessRows as any[]).map(s => s.id);
    if (sessionIds.length === 0) return reply.send({ items: [] });

    // 拉取所有该范围内的未读学生消息
    const msgs = await db.select({ sessionId: assistantChatMessages.sessionId, createdAt: assistantChatMessages.createdAt })
      .from(assistantChatMessages)
      .where(and(
        inArray(assistantChatMessages.sessionId as any, sessionIds as any),
        eq(assistantChatMessages.senderRole as any, 'student' as any),
        eq(assistantChatMessages.status as any, 'unread' as any)
      ));

    if ((msgs as any[]).length === 0) return reply.send({ items: [] });
    const unreadCountBySession = new Map<string, number>();
    for (const m of msgs as any[]) unreadCountBySession.set(m.sessionId!, (unreadCountBySession.get(m.sessionId!) || 0) + 1);

    // 组装学生信息
    const bySession = new Map<string, any>();
    for (const s of sessRows as any[]) bySession.set(s.id, s);
    const byInstanceToStudent: Record<string, string> = {};
    for (const b of bindings as any[]) byInstanceToStudent[b.visitorInstanceId] = b.studentId;
    const studentIds = Array.from(new Set((sessRows as any[]).map(s => byInstanceToStudent[s.visitorInstanceId]).filter(Boolean)));
    const studentRows = studentIds.length > 0 ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id as any, studentIds as any)) : [];
    const nameById = new Map<string, string>();
    for (const u of studentRows as any[]) nameById.set(u.id, u.name);

    const items = Array.from(unreadCountBySession.entries()).map(([sessionId, count]) => {
      const s = bySession.get(sessionId);
      const studentId = byInstanceToStudent[s.visitorInstanceId];
      return {
        sessionId,
        sessionNumber: s.sessionNumber,
        studentId,
        studentName: nameById.get(studentId) || '学生',
        unreadCount: count
      };
    });

    return reply.send({ items });
  });

  // 待批改三联表列表：返回需批改的会话（有三联表但其后无助教回复）
  app.get('/assistant/pending-thought-records', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();

    // 助教负责的绑定
    const bindings = await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, payload.userId));
    const visitorInstanceIds = (bindings as any[]).map(b => b.visitorInstanceId);
    if (visitorInstanceIds.length === 0) return reply.send({ items: [] });

    // 相关会话（已完成）
    const allSessions = await db.select({ id: sessions.id, visitorInstanceId: sessions.visitorInstanceId, sessionNumber: sessions.sessionNumber, createdAt: sessions.createdAt, finalizedAt: sessions.finalizedAt })
      .from(sessions)
      .where(inArray(sessions.visitorInstanceId as any, visitorInstanceIds as any))
      .orderBy(desc(sessions.createdAt as any));
    const completed = (allSessions as any[]).filter(s => s.finalizedAt);
    if (completed.length === 0) return reply.send({ items: [] });

    const sessionIds = completed.map(s => s.id);
    const trs = await db.select({ sessionId: thoughtRecords.sessionId, createdAt: thoughtRecords.createdAt })
      .from(thoughtRecords)
      .where(inArray(thoughtRecords.sessionId as any, sessionIds as any));
    const trCreatedAtBySession = new Map<string, Date>();
    for (const tr of trs as any[]) trCreatedAtBySession.set(tr.sessionId, new Date(tr.createdAt));

    const sessionsWithTr = completed.filter(s => trCreatedAtBySession.has(s.id));
    if (sessionsWithTr.length === 0) return reply.send({ items: [] });

    const msgs = await db.select({ sessionId: assistantChatMessages.sessionId, createdAt: assistantChatMessages.createdAt, senderRole: assistantChatMessages.senderRole })
      .from(assistantChatMessages)
      .where(and(
        inArray(assistantChatMessages.sessionId as any, sessionsWithTr.map(s => s.id) as any),
        eq(assistantChatMessages.senderRole as any, 'assistant_tech' as any)
      ));

    const hasReplyAfterTr = new Set<string>();
    for (const m of msgs as any[]) {
      const trAt = trCreatedAtBySession.get(m.sessionId!);
      if (!trAt) continue;
      if (new Date(m.createdAt) >= trAt) {
        hasReplyAfterTr.add(m.sessionId!);
      }
    }

    const needReview = sessionsWithTr.filter(s => !hasReplyAfterTr.has(s.id));
    if (needReview.length === 0) return reply.send({ items: [] });

    // 关联学生信息（通过绑定表）
    const byInstanceToStudent: Record<string, string> = {};
    for (const b of bindings as any[]) byInstanceToStudent[b.visitorInstanceId] = b.studentId;
    const studentIds = Array.from(new Set(needReview.map(s => byInstanceToStudent[s.visitorInstanceId]).filter(Boolean)));
    const studentsRows = studentIds.length > 0 ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id as any, studentIds as any)) : [];
    const nameById = new Map<string, string>();
    for (const u of studentsRows as any[]) nameById.set(u.id, u.name);

    const items = needReview.map(s => {
      const studentId = byInstanceToStudent[s.visitorInstanceId];
      return {
        studentId,
        studentName: nameById.get(studentId) || '学生',
        sessionId: s.id,
        sessionNumber: s.sessionNumber,
        submittedAt: trCreatedAtBySession.get(s.id)?.toISOString() || null,
      };
    });

    return reply.send({ items });
  });

  // Playground: ensure 10 instances for assistant（技术助教、行政助教、管理员）
  app.post('/playground/ensure', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'assistant_class', 'admin']);
    // 通过权限校验后直接允许，无附加“主身份=student”限制
    const db = createDb();
    const userId = (payload as any).userId;
    const templates = await db.select().from(visitorTemplates);
    const existing = await db.select().from(visitorInstances).where(eq(visitorInstances.userId as any, userId));
    const haveTpl = new Set((existing as any[]).map((v: any) => v.templateId));
    for (const t of templates as any[]) {
      if (!haveTpl.has((t as any).id)) {
        await db.insert(visitorInstances).values({
          id: crypto.randomUUID(),
          userId,
          templateId: (t as any).id,
          longTermMemory: {
            thisweek_focus: '助教体验',
            discussed_topics: '—',
            milestones: '—',
            recurring_patterns: '—',
            core_belief_evolution: '—',
          } as any,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);
      }
    }
    return reply.send({ ok: true });
  });

  // Playground: list personal instances（技术助教、行政助教、管理员）
  app.get('/playground/instances', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'assistant_class', 'admin']);
    // 通过权限校验后直接允许
    const db = createDb();
    const userId = (payload as any).userId;
    const rows = await db.select({
      id: visitorInstances.id,
      createdAt: visitorInstances.createdAt,
      templateKey: visitorTemplates.templateKey,
      name: visitorTemplates.name,
    }).from(visitorInstances)
      .leftJoin(visitorTemplates, eq(visitorTemplates.id as any, visitorInstances.templateId as any))
      .where(eq(visitorInstances.userId as any, userId))
      .orderBy(desc(visitorInstances.createdAt as any));
    const items = (rows as any[]).map((r: any) => ({ instanceId: r.id, templateKey: r.templateKey, name: r.name, createdAt: r.createdAt }));
    return reply.send({ items });
  });

  // Playground: get LTM and history for a visitor instance owned by current user
  app.get('/playground/ltm', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'assistant_class', 'admin']);
    if ((req as any).auth?.role === 'student') return reply.status(403).send({ error: 'forbidden' });
    const db = createDb();
    const { visitorInstanceId } = (req.query || {}) as any;
    if (!visitorInstanceId) return reply.status(400).send({ error: 'missing visitorInstanceId' });
    // ownership
    const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
    if (!inst || (inst as any).userId !== (payload as any).userId) return reply.status(403).send({ error: 'forbidden' });
    const [tpl] = await db.select({ templateKey: visitorTemplates.templateKey, name: visitorTemplates.name }).from(visitorTemplates).where(eq(visitorTemplates.id as any, (inst as any).templateId));
    const ltmHist = await db.select({ createdAt: longTermMemoryVersions.createdAt, content: longTermMemoryVersions.content }).from(longTermMemoryVersions).where(eq(longTermMemoryVersions.visitorInstanceId as any, visitorInstanceId)).orderBy(desc(longTermMemoryVersions.createdAt as any));
    const sess = await db.select({ id: sessions.id, sessionNumber: sessions.sessionNumber, createdAt: sessions.createdAt, sessionDiary: sessions.sessionDiary, preSessionActivity: sessions.preSessionActivity }).from(sessions).where(eq(sessions.visitorInstanceId as any, visitorInstanceId)).orderBy(desc(sessions.sessionNumber as any));
    return reply.send({
      instanceId: visitorInstanceId,
      visitor: tpl || null,
      currentLtm: (inst as any).longTermMemory,
      ltmHistory: ltmHist,
      sessions: sess,
    });
  });

  // 技术助教可编辑的模板列表（含 core_persona 原文）
  app.get('/assistant/templates', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    // 读取白名单 inchargeVisitor（技术助教负责的模板 keys）
    const [white] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, (payload as any).email || (req as any).auth?.email));
    const keys: string[] = Array.isArray((white as any)?.inchargeVisitor) ? (white as any).inchargeVisitor : [];
    if (keys.length === 0) return reply.send({ items: [] });
    const items = await db.select({
      templateKey: visitorTemplates.templateKey,
      name: visitorTemplates.name,
      brief: visitorTemplates.brief,
      corePersona: visitorTemplates.corePersona,
      updatedAt: visitorTemplates.updatedAt,
    }).from(visitorTemplates).where(inArray(visitorTemplates.templateKey, keys));
    // 将 jsonb/string 统一转为字符串返回
    const normalized = (items as any[]).map((t: any) => ({
      ...t,
      corePersona: typeof t.corePersona === 'string' ? t.corePersona : JSON.stringify(t.corePersona ?? ''),
    }));
    return reply.send({ items: normalized });
  });

  // 更新模板的 name/brief/core_persona（仅技术助教负责范围内）
  app.put('/assistant/templates/:templateKey', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['assistant_tech', 'admin']);
    const db = createDb();
    const { templateKey } = (req.params || {}) as any;
    const body = (req.body || {}) as any;

    if (!templateKey) return reply.status(400).send({ error: 'missing templateKey' });

    // 权限：需属于该助教负责的模板
    if ((req as any).auth?.role !== 'admin') {
      const [white] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, (payload as any).email || (req as any).auth?.email));
      const keys: string[] = Array.isArray((white as any)?.inchargeVisitor) ? (white as any).inchargeVisitor : [];
      if (!keys.includes(String(templateKey))) {
        return reply.status(403).send({ error: 'forbidden' });
      }
    }

    const updates: any = {};
    if (typeof body.name === 'string') updates.name = body.name;
    if (typeof body.brief === 'string') updates.brief = body.brief;
    if (typeof body.corePersona !== 'undefined') {
      // 统一存为文本列
      const textContent = typeof body.corePersona === 'string' ? body.corePersona : JSON.stringify(body.corePersona);
      updates.corePersona = textContent as any;
    }
    updates.updatedAt = new Date();

    try {
      await db.update(visitorTemplates).set(updates as any).where(eq(visitorTemplates.templateKey as any, templateKey));
    } catch (e) {
      req.log?.error({ err: e, updates }, 'update visitor_templates failed');
      return reply.status(500).send({ error: 'update template failed' });
    }

    // 写入版本历史（只针对 corePersona 变更）
    // 历史留痕功能已移除
    const [row] = await db.select({
      templateKey: visitorTemplates.templateKey,
      name: visitorTemplates.name,
      brief: visitorTemplates.brief,
      corePersona: visitorTemplates.corePersona,
      updatedAt: visitorTemplates.updatedAt,
    }).from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, templateKey));
    return reply.send({ ok: true, item: row });
  });

  // 历史版本接口已移除

  // 聊天：获取消息（学生/助教均可）
  app.get('/assistant/chat', async (req, reply) => {
    const db = createDb();
    const payload = (req as any).auth;
    const { sessionId } = (req.query || {}) as any;
    if (!sessionId) return reply.status(400).send({ error: 'missing sessionId' });

    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });

    // 授权：学生必须为会话所属实例的 owner；助教需与该实例绑定
    if (payload.role === 'student') {
      const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
      if (!inst || (inst as any).userId !== payload.userId) return reply.status(403).send({ error: 'forbidden' });
    } else if (payload.role === 'assistant_tech') {
      const [bind] = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, (s as any).visitorInstanceId)));
      if (!bind) return reply.status(403).send({ error: 'forbidden' });
    }

    const rows = await db.select().from(assistantChatMessages).where(eq(assistantChatMessages.sessionId as any, sessionId)).orderBy(desc(assistantChatMessages.createdAt as any));
    // 未读计数：对方发来的且状态为 unread
    const unreadCount = (rows as any[]).filter(m => m.status === 'unread' && m.senderRole !== payload.role).length;
    return reply.send({ items: rows, unreadCount });
  });

  // 聊天：发送消息（学生/助教均可）
  app.post('/assistant/chat', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId', 'content'],
        properties: { sessionId: { type: 'string' }, content: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const payload = (req as any).auth;
    const { sessionId, content } = (req.body || {}) as any;
    if (!sessionId || !content) return reply.status(400).send({ error: 'missing params' });
    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });

    if (payload.role === 'student') {
      const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
      if (!inst || (inst as any).userId !== payload.userId) return reply.status(403).send({ error: 'forbidden' });
    } else if (payload.role === 'assistant_tech') {
      const [bind] = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, (s as any).visitorInstanceId)));
      if (!bind) return reply.status(403).send({ error: 'forbidden' });
    } else {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const id = crypto.randomUUID();
    await db.insert(assistantChatMessages).values({
      id,
      sessionId,
      senderRole: payload.role,
      senderId: payload.userId,
      content,
      createdAt: new Date(),
    } as any);
    return reply.send({ id });
  });

  // 标记消息为已读（将对方消息置为 read）
  app.post('/assistant/chat/read', async (req, reply) => {
    const db = createDb();
    const payload = (req as any).auth;
    const { sessionId } = (req.body || {}) as any;
    if (!sessionId) return reply.status(400).send({ error: 'missing sessionId' });

    const [s] = await db.select().from(sessions).where(eq(sessions.id as any, sessionId));
    if (!s) return reply.status(404).send({ error: 'session not found' });
    if (payload.role === 'student') {
      const [inst] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, (s as any).visitorInstanceId));
      if (!inst || (inst as any).userId !== payload.userId) return reply.status(403).send({ error: 'forbidden' });
    } else if (payload.role === 'assistant_tech') {
      const [bind] = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, payload.userId), eq(assistantStudents.visitorInstanceId as any, (s as any).visitorInstanceId)));
      if (!bind) return reply.status(403).send({ error: 'forbidden' });
    } else {
      return reply.status(403).send({ error: 'forbidden' });
    }

    await db.update(assistantChatMessages)
      .set({ status: 'read' } as any)
      .where(and(eq(assistantChatMessages.sessionId as any, sessionId), eq(assistantChatMessages.status as any, 'unread' as any)));
    return reply.send({ ok: true });
  });
}
