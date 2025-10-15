import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { users, visitorInstances, visitorTemplates } from '../../db/schema';
import { verificationCodes, whitelistEmails } from '../../db/schema';
import { userRoleGrants } from '../../db/schema';
import { eq, inArray, desc, isNull } from 'drizzle-orm';
import { signJwt } from '../auth/jwt';

// 新增导入 assistantStudents，用于从绑定推导负责助教
import { assistantStudents } from '../../db/schema';

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function registerAuthRoutes(app: FastifyInstance) {
  // 请求验证码
  app.post('/auth/request-code', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const { email } = req.body as any;
    const normEmail = (email || '').toString().trim().toLowerCase();

    // 白名单校验（要求存在于 whitelist_emails）
    const [white] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, normEmail));
    if (!white) return reply.status(403).send({ error: 'email not in whitelist' });

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    // 使之前未使用的验证码失效（保证只有最新一条可用）
    await db.update(verificationCodes).set({ consumedAt: new Date() } as any).where(eq(verificationCodes.email as any, normEmail));
    await db.insert(verificationCodes).values({ id: crypto.randomUUID(), email: normEmail, code, expiresAt, createdAt: new Date() } as any);

    // 开发环境直接返回 code；生产应发送邮件
    return reply.send({ ok: true, code });
  });

  // 校验验证码并登录
  app.post('/auth/verify-code', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'code'],
        properties: { email: { type: 'string' }, code: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const db = createDb();
    const { email, code } = req.body as any;
    const normEmail = (email || '').toString().trim().toLowerCase();
    const codeStr = (code ?? '').toString().trim();

    // 只接受最新、未使用、未过期的一条验证码
    const rows = await db
      .select()
      .from(verificationCodes)
      .where(eq(verificationCodes.email as any, normEmail))
      .orderBy(desc(verificationCodes.createdAt as any))
      .limit(5);
    const rec = rows.find((r: any) => !r.consumedAt);

    if (!rec || rec.code !== codeStr || (rec.expiresAt && rec.expiresAt < new Date())) {
      return reply.status(400).send({ error: 'invalid code' });
    }

    // 读取白名单确定角色与可选姓名
    const [white] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, normEmail));
    if (!white) return reply.status(403).send({ error: 'email not in whitelist' });

    // upsert 用户
    const [existing] = await db.select().from(users).where(eq(users.email as any, normEmail));
    let userId = existing?.id;
    if (!existing) {
      userId = crypto.randomUUID();
      await db.insert(users).values({ id: userId, email: normEmail, name: (white as any).name || null, role: (white as any).role, classId: (white as any).classId || null, userId: (white as any).userId || null, status: (white as any).status || 'active', createdAt: new Date(), updatedAt: new Date() } as any);
    }

    // 标记验证码已使用
    await db
      .update(verificationCodes)
      .set({ consumedAt: new Date() } as any)
      .where(eq(verificationCodes.id as any, (rec as any).id));

    // 聚合角色
    const roles = new Set<string>();
    if ((white as any).role) roles.add((white as any).role);
    // 附加授权（多角色）
    const grants = await db.select().from(userRoleGrants).where(eq(userRoleGrants.userId as any, userId!));
    for (const g of grants as any[]) roles.add((g as any).role);
    // 将 users 表中的当前主角色也合并进 JWT roles（用于识别具备 student 授权的行政助教）
    const [userRowForRoles] = await db.select({ role: users.role }).from(users).where(eq(users.id as any, userId!));
    if ((userRowForRoles as any)?.role) roles.add((userRowForRoles as any).role);

    // 班级作用域（仅 assistant_class 需要）
    const classScopes: Array<{ role: string; classId?: number }> = [];
    for (const g of grants as any[]) {
      if ((g as any).role === 'assistant_class') {
        classScopes.push({ role: 'assistant_class', classId: (g as any).classId || (white as any).classId || undefined });
      }
    }
    // 若主身份就是 assistant_class，也加入其白名单 classId
    if ((white as any).role === 'assistant_class') {
      classScopes.push({ role: 'assistant_class', classId: (white as any).classId || undefined });
    }

    const token = await signJwt({ userId: userId!, role: (white as any).role, roles: Array.from(roles), email: normEmail, classScopes });
    return reply.send({ token, roles: Array.from(roles) });
  });

  // 当前用户（增强版）
  app.get('/me', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    const db = createDb();
    const payload = req.auth as any;

    // 获取用户信息
    const [user] = await db.select().from(users).where(eq(users.id as any, payload.userId));
    if (!user) return reply.status(404).send({ error: 'user not found' });

    // 获取白名单信息以获取 userId（助教从绑定推导）
    const [whitelist] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, payload.email));

    let visitorInstanceIds: string[] | undefined = undefined;
    let currentVisitor: any = undefined;
    let assignedTechAsst: any = undefined;
    let assignedVisitorTemplates: any[] | undefined = undefined;

    // 学生角色（支持多角色）：返回 visitorInstanceIds 和 currentVisitor 信息
    const hasStudentRole = payload.role === 'student' || ((payload as any).roles || []).includes('student');
    const treatAsStudent = hasStudentRole; // 仅当确有 student 授权时才以学生视角返回数据
    if (treatAsStudent) {
      let instances = await db.select({
        id: visitorInstances.id,
        templateId: visitorInstances.templateId,
      }).from(visitorInstances).where(eq(visitorInstances.userId as any, payload.userId));

      // 仅学生角色下，且当完全没有实例且白名单存在 assignedVisitor 时，创建该模板实例；否则不再向下兜底
      if (!instances.length && hasStudentRole && (whitelist as any)?.assignedVisitor) {
        try {
          const key = String((whitelist as any).assignedVisitor);
          const [tpl] = await db.select({ id: visitorTemplates.id }).from(visitorTemplates)
            .where(eq(visitorTemplates.templateKey as any, key));
          if (tpl) {
            const id = crypto.randomUUID();
            await db.insert(visitorInstances).values({
              id,
              userId: payload.userId,
              templateId: (tpl as any).id,
              longTermMemory: {
                thisweek_focus: '',
                discussed_topics: '',
                milestones: '',
                recurring_patterns: '',
                core_belief_evolution: '',
              } as any,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any);
            instances = [{ id, templateId: (tpl as any).id } as any];
          }
        } catch {}
      }

      // 计算绑定优先与 assignedVisitor 匹配优先的 currentVisitor，并按优先顺序输出 visitorInstanceIds
      const instanceIds = instances.map(r => (r as any).id as string);
      visitorInstanceIds = instanceIds;

      // 获取学生→助教绑定（取第一条）
      let boundInstanceId: string | null = null;
      try {
        const binds = await db.select().from(assistantStudents).where(eq(assistantStudents.studentId as any, payload.userId));
        if ((binds as any[]).length) {
          boundInstanceId = (binds[0] as any).visitorInstanceId as string;
          const aid = (binds[0] as any).assistantId as string;
          const rows = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id as any, aid));
          const techAsst = rows[0] as any;
          if (techAsst) {
            assignedTechAsst = { name: techAsst.name || (techAsst.email?.split('@')[0]), email: techAsst.email };
          }
        }
      } catch {}

      // 准备模板映射以匹配 assignedVisitor
      const tplIdSet = Array.from(new Set(instances.map(i => (i as any).templateId as string)));
      let templateRows: Array<{ id: string; templateKey: string; name: string }> = [];
      if (tplIdSet.length) {
        const rows = await db.select({ id: visitorTemplates.id, templateKey: visitorTemplates.templateKey, name: visitorTemplates.name })
          .from(visitorTemplates).where(inArray(visitorTemplates.id as any, tplIdSet as any));
        templateRows = rows as any;
      }
      const templateKeyById = new Map<string, { key: string; name: string }>(templateRows.map(t => [(t as any).id, { key: (t as any).templateKey, name: (t as any).name }]));

      const assignedKey = (whitelist as any)?.assignedVisitor ? String((whitelist as any).assignedVisitor) : null;
      let assignedMatchInstanceId: string | null = null;
      if (assignedKey) {
        const match = instances.find(i => templateKeyById.get((i as any).templateId)?.key === assignedKey);
        assignedMatchInstanceId = match ? (match as any).id : null;
      }

      // 选择 currentVisitor：优先绑定实例，其次 assignedVisitor 匹配实例
      let chosenInstanceId: string | null = null;
      if (boundInstanceId && instanceIds.includes(boundInstanceId)) chosenInstanceId = boundInstanceId;
      else if (assignedMatchInstanceId) chosenInstanceId = assignedMatchInstanceId;

      if (chosenInstanceId) {
        // 将 chosen 放在 visitorInstanceIds 首位
        visitorInstanceIds = [chosenInstanceId, ...instanceIds.filter(id => id !== chosenInstanceId)];
        const chosen = instances.find(i => (i as any).id === chosenInstanceId)!;
        const t = templateKeyById.get((chosen as any).templateId);
        if (t) {
          currentVisitor = { instanceId: chosenInstanceId, name: t.name, templateKey: t.key };
        }
      } else {
        // 若没有任何匹配，则不再向下兜底；保持 currentVisitor 为空
      }
    }

    // 技术助教角色：返回负责的访客模板信息
    if (payload.role === 'assistant_tech') {
      if (whitelist && (whitelist as any).inchargeVisitor && Array.isArray((whitelist as any).inchargeVisitor)) {
        const templateKeys = (whitelist as any).inchargeVisitor;
        if (templateKeys.length > 0) {
          const templates = await db.select({
            templateKey: visitorTemplates.templateKey,
            name: visitorTemplates.name,
            brief: visitorTemplates.brief,
          }).from(visitorTemplates).where(inArray(visitorTemplates.templateKey, templateKeys));

          assignedVisitorTemplates = templates.map(t => ({
            templateKey: t.templateKey,
            name: t.name,
            brief: t.brief
          }));
        }
      }
    }

    return reply.send({
      userId: payload.userId,
      email: payload.email,
      name: (user as any).name || null,
      role: payload.role,
      roles: (payload as any).roles || (payload.role ? [payload.role] : []),
      classScopes: (payload as any).classScopes || [],
      studentId: whitelist ? (whitelist as any).userId : null,
      visitorInstanceIds,
      currentVisitor,
      assignedTechAsst,
      assignedVisitorTemplates
    });
  });
}
