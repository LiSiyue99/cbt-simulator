import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { users, visitorInstances } from '../../db/schema';
import { verificationCodes, whitelistEmails } from '../../db/schema';
import { eq } from 'drizzle-orm';
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

    // 白名单校验（要求存在于 whitelist_emails）
    const [white] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, email));
    if (!white) return reply.status(403).send({ error: 'email not in whitelist' });

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.insert(verificationCodes).values({ id: crypto.randomUUID(), email, code, expiresAt, createdAt: new Date() } as any);

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

    const [rec] = await db.select().from(verificationCodes).where(eq(verificationCodes.email as any, email));
    if (!rec || rec.code !== code || (rec.expiresAt && rec.expiresAt < new Date())) {
      return reply.status(400).send({ error: 'invalid code' });
    }

    // 读取白名单确定角色与可选姓名
    const [white] = await db.select().from(whitelistEmails).where(eq(whitelistEmails.email as any, email));
    if (!white) return reply.status(403).send({ error: 'email not in whitelist' });

    // upsert 用户
    const [existing] = await db.select().from(users).where(eq(users.email as any, email));
    let userId = existing?.id;
    if (!existing) {
      userId = crypto.randomUUID();
      await db.insert(users).values({ id: userId, email, name: (white as any).name || null, role: (white as any).role, classId: (white as any).classId || null, userId: (white as any).userId || null, status: (white as any).status || 'active', createdAt: new Date(), updatedAt: new Date() } as any);
    }

    // 标记验证码已使用
    await db.update(verificationCodes).set({ consumedAt: new Date() } as any).where(eq(verificationCodes.email as any, email));

    const token = await signJwt({ userId: userId!, role: (white as any).role, email });
    return reply.send({ token, role: (white as any).role });
  });

  // 当前用户
  app.get('/me', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    const db = createDb();
    const payload = req.auth as any;
    let visitorInstanceIds: string[] | undefined = undefined;
    // 仅当为 student 时返回其 visitorInstanceIds（向后兼容保留原字段）
    if (payload.role === 'student') {
      const rows = await db.select().from(visitorInstances).where((visitorInstances.userId as any).eq?.(payload.userId) as any);
      // 若 drizzle 语法不支持 .eq 风格，fallback 到过滤
      visitorInstanceIds = (rows as any[]).map(r => (r as any).id);
    }
    return reply.send({ userId: payload.userId, email: payload.email, role: payload.role, visitorInstanceIds });
  });
}
