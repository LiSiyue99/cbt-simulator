import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { users, visitorInstances, visitorTemplates } from '../../db/schema';
import { verificationCodes, whitelistEmails } from '../../db/schema';
import { userRoleGrants } from '../../db/schema';
import { eq, inArray, desc, isNull } from 'drizzle-orm';
import { signJwt } from '../auth/jwt';

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

    // 获取白名单信息以获取 userId 和 assignedTechAsst
    const [whitelist] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, payload.email));

    let visitorInstanceIds: string[] | undefined = undefined;
    let currentVisitor: any = undefined;
    let assignedTechAsst: any = undefined;
    let assignedVisitorTemplates: any[] | undefined = undefined;

    // 学生角色：返回 visitorInstanceIds 和 currentVisitor 信息
    if (payload.role === 'student') {
      const instances = await db.select({
        id: visitorInstances.id,
        templateId: visitorInstances.templateId,
      }).from(visitorInstances).where(eq(visitorInstances.userId as any, payload.userId));

      visitorInstanceIds = instances.map(r => r.id as string);

      // 获取第一个访客实例的详细信息作为当前访客
      if (instances.length > 0) {
        const firstInstance = instances[0];
        const [template] = await db.select({
          name: visitorTemplates.name,
          templateKey: visitorTemplates.templateKey,
        }).from(visitorTemplates).where(eq(visitorTemplates.id as any, firstInstance.templateId));

        if (template) {
          currentVisitor = {
            instanceId: firstInstance.id,
            name: template.name,
            templateKey: template.templateKey
          };
        }
      }

      // 获取负责该学生的技术助教信息（兼容 assignedTechAsst 为邮箱或业务编号）
      if (whitelist && (whitelist as any).assignedTechAsst) {
        const at = String((whitelist as any).assignedTechAsst);
        let techAsst: any | undefined;
        if (at.includes('@')) {
          const rows = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.email as any, at));
          techAsst = rows[0];
        } else {
          const rows = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.userId as any, at));
          techAsst = rows[0];
          // 若按 userId 未找到，回退按 email 再试一次（容错）
          if (!techAsst && at) {
            const rows2 = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.email as any, at));
            techAsst = rows2[0];
          }
        }
        if (techAsst) {
          assignedTechAsst = {
            name: (techAsst as any).name || (techAsst as any).email?.split('@')[0],
            email: (techAsst as any).email
          };
        }
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
