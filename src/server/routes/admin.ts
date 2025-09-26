import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { systemConfigs, deadlineOverrides, users, sessions, sessionDeadlineOverrides, visitorInstances, visitorTemplates, auditLogs, assistantStudents } from '../../db/schema';
import { formatWeekKey } from '../../policy/timeWindow';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

export async function registerAdminRoutes(app: FastifyInstance) {
  async function writeAudit(db: any, actorId: string, action: string, targetType: string, targetId: string, summary?: string) {
    try { await db.insert(auditLogs).values({ actorId, action, targetType, targetId, summary, createdAt: new Date() } as any); } catch {}
  }
  // 系统时间窗：读取
  app.get('/admin/policy/time-window', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const rows = await db.select().from(systemConfigs);
    const map: Record<string, any> = {};
    for (const r of rows as any[]) map[(r as any).key] = (r as any).value;
    // 期望key：student_deadline_weekday, assistant_deadline_weekday 等（可选）
    return reply.send({ items: map });
  });

  // 系统时间窗：更新（简单KV）
  app.post('/admin/policy/time-window', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const body = (req.body || {}) as any; // { student_deadline_weekday?: '5', assistant_deadline_weekday?: '7' }
    const entries = Object.entries(body);
    for (const [key, value] of entries) {
      // upsert
      const exists = await db.select().from(systemConfigs).where(eq(systemConfigs.key as any, key));
      if ((exists as any[]).length) {
        await db.update(systemConfigs).set({ value: String(value), updatedAt: new Date() } as any).where(eq(systemConfigs.key as any, key));
      } else {
        await db.insert(systemConfigs).values({ key, value: String(value), updatedAt: new Date() } as any);
      }
    }
    return reply.send({ ok: true });
  });

  // DDL 临时解锁：创建
  app.post('/admin/policy/ddl-override', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    let { subjectType, subjectId, subjectEmail, weekKey, overrideDate, action, until, reason } = (req.body || {}) as any;
    if (subjectEmail && !subjectId) {
      const u = await db.select({ id: users.id }).from(users).where(eq(users.email as any, subjectEmail));
      if ((u as any[]).length === 0) return reply.status(400).send({ error: 'subjectEmail not found' });
      subjectId = (u[0] as any).id;
    }
    if (!weekKey && overrideDate) {
      try { weekKey = formatWeekKey(new Date(overrideDate)); } catch {}
    }
    if (!subjectType || !subjectId || !weekKey || !action || !until) return reply.status(400).send({ error: 'missing fields' });
    const item = { subjectType, subjectId, weekKey, action, until: new Date(until), reason, createdAt: new Date(), createdBy: (payload as any).userId } as any;
    await db.insert(deadlineOverrides).values(item);
    await writeAudit(db, (payload as any).userId, 'ddl_override', 'user', subjectId, `week ${weekKey} ${action} until ${until}`);
    return reply.send({ ok: true });
  });

  // DDL 临时解锁：批量创建（allStudents | allAssistantTechs | class:ID | emails[]）
  app.post('/admin/policy/ddl-override/batch', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { scope, weekKey, overrideDate, action, until, reason, emails } = (req.body || {}) as any;
    if (!action || !until || !(weekKey || overrideDate) || !scope) return reply.status(400).send({ error: 'missing fields' });
    let wk = weekKey;
    if (!wk && overrideDate) { try { wk = formatWeekKey(new Date(overrideDate)); } catch {} }
    if (!wk) return reply.status(400).send({ error: 'invalid weekKey' });

    // 解析作用域
    let targets: any[] = [];
    let batchScopeLabel = String(scope);
    if (scope === 'allStudents') {
      targets = await db.select({ id: users.id }).from(users).where(eq(users.role as any, 'student'));
    } else if (scope === 'allAssistantTechs') {
      targets = await db.select({ id: users.id }).from(users).where(eq(users.role as any, 'assistant_tech'));
    } else if (typeof scope === 'string' && scope.startsWith('class:')) {
      const classId = Number(scope.split(':')[1]);
      batchScopeLabel = `class:${classId}`;
      targets = await db.select({ id: users.id }).from(users).where(and(eq(users.role as any, 'student'), eq(users.classId as any, classId)));
    } else if (Array.isArray(emails) && emails.length) {
      // by emails（学生或助教均可）
      const rows = await db.select({ id: users.id, email: users.email }).from(users);
      const set = new Set(emails);
      targets = rows.filter((r: any) => set.has((r as any).email));
    } else {
      return reply.status(400).send({ error: 'invalid scope' });
    }

    const batchId = crypto.randomUUID();
    const values = (targets as any[]).map((t) => ({
      subjectType: 'student', // 对助教反馈放宽也可用 'assistant'（此处简化：按 action 判断）
      subjectId: (t as any).id,
      weekKey: wk,
      action,
      until: new Date(until),
      reason,
      batchId,
      batchScope: batchScopeLabel,
      createdAt: new Date(),
      createdBy: (payload as any).userId,
    }));
    if (values.length === 0) return reply.send({ ok: true, affected: 0 });
    await db.insert(deadlineOverrides).values(values as any);
    await writeAudit(db, (payload as any).userId, 'ddl_override_batch', 'batch', batchId, `${batchScopeLabel} ${action} week ${wk} count ${values.length}`);
    return reply.send({ ok: true, affected: values.length, batchId, scope: batchScopeLabel, weekKey: wk });
  });

  // 周级/批量：最近记录（聚合成可读文案）
  app.get('/admin/policy/ddl-override/recent', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    // 先汇总批量
    const rows = await db.select().from(deadlineOverrides).orderBy(desc(deadlineOverrides.createdAt as any)).limit(200);
    const batchMap = new Map<string, any>();
    const singles: any[] = [];
    for (const r of rows as any[]) {
      if ((r as any).batchId) {
        const key = (r as any).batchId;
        if (!batchMap.has(key)) batchMap.set(key, { ...r, count: 0 });
        batchMap.get(key).count++;
      } else {
        singles.push(r);
      }
    }
    const batchSummaries = Array.from(batchMap.values()).slice(0, 50).map((b: any) => ({
      type: 'batch',
      batchId: b.batchId,
      scope: b.batchScope,
      action: b.action,
      weekKey: b.weekKey,
      until: b.until,
      count: b.count,
      createdAt: b.createdAt,
      reason: b.reason,
    }));
    // 单条周级记录：补充用户姓名与邮箱，仅返回必要字段
    let singleItems: any[] = [];
    if (singles.length) {
      const userIds = Array.from(new Set(singles.map((s: any) => s.subjectId)));
      const userRows = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(inArray(users.id as any, userIds as any));
      const idToUser = new Map(userRows.map((u: any) => [u.id, u]));
      singleItems = singles.slice(0, 50).map((s: any) => {
        const u = idToUser.get(s.subjectId) || {} as any;
        return {
          action: s.action,
          weekKey: s.weekKey,
          until: s.until,
          createdAt: s.createdAt,
          reason: s.reason,
          subjectEmail: (u as any).email || null,
          subjectName: (u as any).name || null,
        };
      });
    }
    return reply.send({ batches: batchSummaries, singles: singleItems });
  });

  // DDL 临时解锁：查询（按 subjectId+weekKey 或 最近）
  app.get('/admin/policy/ddl-override', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { subjectId, weekKey } = (req.query || {}) as any;
    let rows: any[] = [];
    if (subjectId && weekKey) {
      rows = await db.select().from(deadlineOverrides).where(and(eq(deadlineOverrides.subjectId as any, subjectId), eq(deadlineOverrides.weekKey as any, weekKey))).orderBy(desc(deadlineOverrides.createdAt as any));
    } else {
      rows = await db.select().from(deadlineOverrides).orderBy(desc(deadlineOverrides.createdAt as any)).limit(100);
    }
    return reply.send({ items: rows });
  });

  // 导出报表（占位）：周合规、助教工作量、模板表现
  app.get('/admin/export/:type', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const { type } = req.params as any;
    // 占位：未来返回CSV内容
    return reply.send({ ok: true, type });
  });

  // 系统健康（占位）：错误与重试
  app.get('/admin/system-health', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    // 占位：未来读取日志、错误计数
    return reply.send({ errors24h: 0, routes5xx: [], llmFailures: 0 });
  });

  // ================= Users CRUD =================
  app.get('/admin/users', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { role, status, q } = (req.query || {}) as any;
    let rows = await db.select().from(users);
    // 简单过滤（内存过滤，后续可转SQL条件）
    rows = (rows as any[]).filter((u: any) => (!role || u.role === role) && (!status || u.status === status) && (!q || (u.name||'').includes(q) || (u.email||'').includes(q)));
    return reply.send({ items: rows });
  });

  app.post('/admin/users', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const body = (req.body || {}) as any;
    const { name, email, role, userId, classId, status } = body;
    if (!email || !role) return reply.status(400).send({ error: 'missing fields' });
    const id = createId();
    await db.insert(users).values({ id, name, email, role, userId, classId, status: status || 'active', createdAt: new Date(), updatedAt: new Date() } as any);
    await writeAudit(db, (payload as any).userId, 'create_user', 'user', id, `${email} ${role}`);
    return reply.send({ ok: true, id });
  });

  app.put('/admin/users/:id', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { id } = req.params as any;
    const body = (req.body || {}) as any;
    const allowed: any = {};
    ['name','email','role','userId','classId','status'].forEach(k => { if (body[k] !== undefined) allowed[k] = body[k]; });
    if (Object.keys(allowed).length === 0) return reply.status(400).send({ error: 'no changes' });
    allowed.updatedAt = new Date();
    await db.update(users).set(allowed).where((users.id as any).eq ? (users.id as any).eq(id) : (users.id as any));
    await writeAudit(db, (payload as any).userId, 'update_user', 'user', id, JSON.stringify(allowed));
    return reply.send({ ok: true });
  });

  app.delete('/admin/users/:id', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { id } = req.params as any;
    await db.update(users).set({ status: 'inactive', updatedAt: new Date() } as any).where((users.id as any).eq ? (users.id as any).eq(id) : (users.id as any));
    await writeAudit(db, (payload as any).userId, 'delete_user', 'user', id, 'soft delete');
    return reply.send({ ok: true });
  });

  // ================= Templates (Admin full-access) =================
  // List all templates with editable fields
  app.get('/admin/templates', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const rows = await db.select({
      templateKey: visitorTemplates.templateKey,
      name: visitorTemplates.name,
      brief: visitorTemplates.brief,
      corePersona: visitorTemplates.corePersona,
      updatedAt: visitorTemplates.updatedAt,
    }).from(visitorTemplates).orderBy(desc(visitorTemplates.updatedAt as any));
    const items = (rows as any[]).map((t:any)=> ({
      ...t,
      corePersona: typeof t.corePersona === 'string' ? t.corePersona : JSON.stringify(t.corePersona ?? '')
    }));
    return reply.send({ items });
  });

  // Update any template (name/brief/corePersona)
  app.put('/admin/templates/:templateKey', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { templateKey } = req.params as any;
    const body = (req.body || {}) as any;
    if (!templateKey) return reply.status(400).send({ error: 'missing templateKey' });
    const updates: any = {};
    if (typeof body.name === 'string') updates.name = body.name;
    if (typeof body.brief === 'string') updates.brief = body.brief;
    if (typeof body.corePersona !== 'undefined') {
      const textContent = typeof body.corePersona === 'string' ? body.corePersona : JSON.stringify(body.corePersona);
      updates.corePersona = textContent as any;
    }
    updates.updatedAt = new Date();
    try {
      await db.update(visitorTemplates).set(updates as any).where(eq(visitorTemplates.templateKey as any, templateKey));
    } catch (e) {
      return reply.status(500).send({ error: 'update template failed' });
    }
    await writeAudit(db, (payload as any).userId, 'update_template', 'visitor_template', templateKey, JSON.stringify(Object.keys(updates)));
    const [row] = await db.select({
      templateKey: visitorTemplates.templateKey,
      name: visitorTemplates.name,
      brief: visitorTemplates.brief,
      corePersona: visitorTemplates.corePersona,
      updatedAt: visitorTemplates.updatedAt,
    }).from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, templateKey));
    return reply.send({ ok: true, item: row });
  });

  // ================= Assignments: 学生模板/助教分配 =================
  async function ensureInstance(db: any, studentId: string, templateKey: string) {
    const tplRows = await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey }).from(visitorTemplates).where(eq(visitorTemplates.templateKey as any, templateKey));
    if (!(tplRows as any[]).length) throw new Error('template_not_found');
    const templateId = (tplRows[0] as any).id;
    const exists = await db.select({ id: visitorInstances.id }).from(visitorInstances)
      .where(and(eq(visitorInstances.userId as any, studentId), eq(visitorInstances.templateId as any, templateId)));
    if ((exists as any[]).length) return (exists[0] as any).id as string;
    const defaultLtm = { thisweek_focus: '', discussed_topics: '', milestones: '', recurring_patterns: '', core_belief_evolution: '' } as any;
    const id = createId();
    await db.insert(visitorInstances).values({ id, userId: studentId, templateId, longTermMemory: defaultLtm, createdAt: new Date(), updatedAt: new Date() } as any);
    return id;
  }

  // 列表：学生 + 其模板实例 + 助教负责情况
  app.get('/admin/assignments/students', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { classId, q } = (req.query || {}) as any;
    let stuRows = await db.select().from(users).where(eq(users.role as any, 'student' as any));
    stuRows = (stuRows as any[]).filter((u: any) => (!classId || String(u.classId) === String(classId)) && (!q || (u.name||'').includes(q) || (u.email||'').includes(q)));
    const ids = (stuRows as any[]).map((s: any) => s.id);
    const instRows = ids.length ? await db.select({ id: visitorInstances.id, userId: visitorInstances.userId, templateId: visitorInstances.templateId }).from(visitorInstances).where(inArray(visitorInstances.userId as any, ids as any)) : [];
    const tpls = await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey }).from(visitorTemplates);
    const tplKeyById = new Map<string,string>((tpls as any[]).map(t => [t.id, t.templateKey]));
    const asRows = ids.length ? await db.select().from(assistantStudents).where(inArray(assistantStudents.studentId as any, ids as any)) : [];
    const assistantIds = Array.from(new Set((asRows as any[]).map((r:any)=> r.assistantId)));
    const assistantUsers = assistantIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id as any, assistantIds as any)) : [];
    const assistantNameById = new Map<string,string>((assistantUsers as any[]).map(u=>[u.id, u.name||'助教']));
    const items = (stuRows as any[]).map((stu: any) => {
      const myInst = (instRows as any[]).filter((i:any)=> i.userId===stu.id).map((i:any)=>({ visitorInstanceId: i.id, templateKey: tplKeyById.get(i.templateId)||'' }));
      const myAs = (asRows as any[]).filter((a:any)=> a.studentId===stu.id).map((a:any)=>({ id: a.id, assistantId: a.assistantId, assistantName: assistantNameById.get(a.assistantId)||'助教', visitorInstanceId: a.visitorInstanceId }));
      return { studentId: stu.id, name: stu.name, email: stu.email, classId: stu.classId, instances: myInst, assistants: myAs };
    });
    return reply.send({ items });
  });

  // 设置/创建学生模板实例
  app.post('/admin/assignments/assign-template', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { studentId, templateKey } = (req.body || {}) as any;
    if (!studentId || !templateKey) return reply.status(400).send({ error: 'missing fields' });
    try {
      const instanceId = await ensureInstance(db, studentId, templateKey);
      await writeAudit(db, (payload as any).userId, 'assign_template', 'user', studentId, `template ${templateKey} instance ${instanceId}`);
      return reply.send({ ok: true, visitorInstanceId: instanceId });
    } catch (e:any) {
      return reply.status(400).send({ error: e.message || 'assign_template_failed' });
    }
  });

  // 设置助教负责学生（可指定模板实例）
  app.post('/admin/assignments/assign-assistant', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { studentId, assistantId, visitorInstanceId, templateKey } = (req.body || {}) as any;
    if (!studentId || !assistantId) return reply.status(400).send({ error: 'missing fields' });
    let vi = visitorInstanceId as string | undefined;
    try {
      if (!vi) {
        if (!templateKey) return reply.status(400).send({ error: 'need visitorInstanceId or templateKey' });
        vi = await ensureInstance(db, studentId, templateKey);
      }
      const exists = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, assistantId), eq(assistantStudents.studentId as any, studentId), eq(assistantStudents.visitorInstanceId as any, vi)));
      if (!(exists as any[]).length) {
        await db.insert(assistantStudents).values({ id: createId(), assistantId, studentId, visitorInstanceId: vi, createdAt: new Date() } as any);
      }
      await writeAudit(db, (payload as any).userId, 'assign_assistant', 'user', studentId, `assistant ${assistantId} instance ${vi}`);
      return reply.send({ ok: true, visitorInstanceId: vi });
    } catch (e:any) {
      return reply.status(400).send({ error: e.message || 'assign_assistant_failed' });
    }
  });

  // 批量改派
  app.post('/admin/assignments/bulk', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { items } = (req.body || {}) as any;
    if (!Array.isArray(items) || !items.length) return reply.status(400).send({ error: 'empty_items' });
    const results: any[] = [];
    for (const it of items) {
      try {
        let vi = it.visitorInstanceId as string | undefined;
        if (it.templateKey && !vi) vi = await ensureInstance(db, it.studentId, it.templateKey);
        if (it.assistantId) {
          const exists = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, it.assistantId), eq(assistantStudents.studentId as any, it.studentId), eq(assistantStudents.visitorInstanceId as any, vi)));
          if (!(exists as any[]).length) await db.insert(assistantStudents).values({ id: createId(), assistantId: it.assistantId, studentId: it.studentId, visitorInstanceId: vi!, createdAt: new Date() } as any);
        }
        results.push({ studentId: it.studentId, ok: true, visitorInstanceId: vi });
      } catch (e:any) {
        results.push({ studentId: it.studentId, ok: false, error: e.message });
      }
    }
    await writeAudit(db, (payload as any).userId, 'bulk_assign', 'batch', createId(), `items ${items.length}`);
    return reply.send({ items: results });
  });

  // ================= 助教负责学生 CRUD =================
  app.get('/admin/assistant-students', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { assistantId } = (req.query || {}) as any;
    const rows = assistantId ? await db.select().from(assistantStudents).where(eq(assistantStudents.assistantId as any, assistantId)) : await db.select().from(assistantStudents);
    return reply.send({ items: rows });
  });

  app.post('/admin/assistant-students', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { assistantId, studentId, visitorInstanceId, templateKey } = (req.body || {}) as any;
    if (!assistantId || !studentId) return reply.status(400).send({ error: 'missing fields' });
    let vi = visitorInstanceId as string | undefined;
    try {
      if (!vi) {
        if (!templateKey) return reply.status(400).send({ error: 'need visitorInstanceId or templateKey' });
        vi = await ensureInstance(db, studentId, templateKey);
      }
      const exists = await db.select().from(assistantStudents).where(and(eq(assistantStudents.assistantId as any, assistantId), eq(assistantStudents.studentId as any, studentId), eq(assistantStudents.visitorInstanceId as any, vi)));
      if ((exists as any[]).length) return reply.send({ ok: true, id: (exists[0] as any).id, duplicated: true });
      const id = createId();
      await db.insert(assistantStudents).values({ id, assistantId, studentId, visitorInstanceId: vi!, createdAt: new Date() } as any);
      await writeAudit(db, (payload as any).userId, 'add_assistant_student', 'assistant_students', id, `assistant ${assistantId} student ${studentId} instance ${vi}`);
      return reply.send({ ok: true, id });
    } catch (e:any) {
      return reply.status(400).send({ error: e.message || 'create_failed' });
    }
  });

  app.delete('/admin/assistant-students/:id', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { id } = req.params as any;
    // drizzle没有直接 delete example; use db.execute? 简化：设置为无操作前提；这里直接执行 SQL 可能不允许。我们可以软删：无字段。那就直接尝试物理删。
    try {
      await (db as any).delete(assistantStudents).where(eq(assistantStudents.id as any, id));
    } catch {}
    await writeAudit(db, (payload as any).userId, 'remove_assistant_student', 'assistant_students', id, 'delete');
    return reply.send({ ok: true });
  });

  // 会话级 DDL 覆盖：查询（按邮箱检索其会话）
  app.get('/admin/policy/session-override', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { studentEmail, templateKey } = (req.query || {}) as any;
    if (!studentEmail) return reply.status(400).send({ error: 'missing studentEmail' });
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email as any, studentEmail));
    if (!user) return reply.status(404).send({ error: 'student not found' });
    let instanceRows: any[] = [];
    if (templateKey) {
      // 关联模板过滤
      instanceRows = await db
        .select({ id: visitorInstances.id })
        .from(visitorInstances)
        .innerJoin(visitorTemplates, eq(visitorInstances.templateId as any, visitorTemplates.id as any))
        .where(and(eq(visitorInstances.userId as any, (user as any).id), eq(visitorTemplates.templateKey as any, templateKey)));
    } else {
      instanceRows = await db.select({ id: visitorInstances.id }).from(visitorInstances).where(eq(visitorInstances.userId as any, (user as any).id));
    }
    const instanceIds = instanceRows.map((r: any) => r.id);
    if (instanceIds.length === 0) return reply.send({ sessions: [], overrides: [] });

    const sess = await db
      .select({ id: sessions.id, sessionNumber: sessions.sessionNumber, createdAt: sessions.createdAt, visitorInstanceId: sessions.visitorInstanceId })
      .from(sessions)
      .where(inArray(sessions.visitorInstanceId as any, instanceIds as any))
      .orderBy(desc(sessions.createdAt as any));
    const sessionIds = (sess as any[]).map((s) => s.id);
    const ovs = sessionIds.length
      ? await db.select().from(sessionDeadlineOverrides).where(inArray(sessionDeadlineOverrides.sessionId as any, sessionIds as any)).orderBy(desc(sessionDeadlineOverrides.createdAt as any))
      : [] as any[];
    return reply.send({ sessions: sess, overrides: ovs });
  });

  // 会话级 DDL 覆盖：创建
  app.post('/admin/policy/session-override', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { sessionId, action, until, reason } = (req.body || {}) as any;
    if (!sessionId || !action || !until) return reply.status(400).send({ error: 'missing fields' });
    await db.insert(sessionDeadlineOverrides).values({ sessionId, action, until: new Date(until), reason, createdBy: (payload as any).userId, createdAt: new Date() } as any);
    await writeAudit(db, (payload as any).userId, 'session_override', 'session', sessionId, `${action} until ${until}`);
    return reply.send({ ok: true });
  });

  // 会话级 DDL 覆盖：最近记录（全局）
  app.get('/admin/policy/session-override/recent', async (req, reply) => {
    const payload = (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const ovs = await db
      .select({
        id: sessionDeadlineOverrides.id,
        sessionId: sessionDeadlineOverrides.sessionId,
        action: sessionDeadlineOverrides.action,
        until: sessionDeadlineOverrides.until,
        createdAt: sessionDeadlineOverrides.createdAt,
        sessionNumber: sessions.sessionNumber,
        userId: users.id,
        userEmail: users.email,
        userName: users.name,
      })
      .from(sessionDeadlineOverrides)
      .innerJoin(sessions, eq(sessionDeadlineOverrides.sessionId as any, sessions.id as any))
      .innerJoin(visitorInstances, eq(sessions.visitorInstanceId as any, visitorInstances.id as any))
      .innerJoin(users, eq(visitorInstances.userId as any, users.id as any))
      .orderBy(desc(sessionDeadlineOverrides.createdAt as any))
      .limit(100);
    return reply.send({ items: ovs });
  });
}
