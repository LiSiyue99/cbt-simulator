import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { registerSessionRoutes } from './routes/sessions';
import { registerAuthRoutes } from './routes/auth';
import { registerAssistantRoutes } from './routes/assistant';
import { registerAdminRoutes } from './routes/admin';
import { registerAssignmentRoutes } from './routes/assignments';
import authPlugin from './plugins/auth';
import { registerAssistantClassRoutes } from './routes/assistantClass';
import { createDb } from '../db/client';
import { sql } from 'drizzle-orm';

export async function buildServer() {
  const app = Fastify({
    logger: true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    connectionTimeout: 300000, // 5 minutes
    keepAliveTimeout: 65000,   // 65 seconds
    requestTimeout: 300000,    // 5 minutes for long-running AI operations
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    // 提高默认限流，满足约114人的并发访问
    max: Number(process.env.RATELIMIT_MAX || 300),
    timeWindow: process.env.RATELIMIT_WINDOW || '1 minute',
    hook: 'preHandler',
  });
  await app.register(authPlugin);

  await registerSessionRoutes(app);
  // thoughtRecords 路由已移除，改为通用作业接口
  await registerAuthRoutes(app);
  await registerAssistantRoutes(app);
  // 旧 questions/feedbacks 已废弃，统一由 assistant chat 替代
  await registerAdminRoutes(app);
  await registerAssignmentRoutes(app);
  await registerAssistantClassRoutes(app);
  // ensure playground routes are registered via assistant routes module (already included)

  // 健康检查：liveness/readiness
  // - GET /health?probe=liveness 仅检查进程存活
  // - GET /health            额外检查数据库连接
  app.get('/health', async (req, reply) => {
    const probe = (req.query as any)?.probe;
    const uptime = process.uptime();
    if (probe === 'liveness') {
      return reply.send({ status: 'ok', uptime });
    }
    try {
      const db = createDb();
      await (db as any).execute(sql`select 1`);
      return reply.send({ status: 'ok', uptime, db: 'ok' });
    } catch (e: any) {
      return reply.status(503).send({ status: 'degraded', uptime, db: 'down' });
    }
  });

  // 版本信息与可观测性：返回构建 ID、时间等
  // - 优先读取运行目录中的 BUILD_INFO.json（由部署脚本生成）
  // - 若不存在则回退到环境变量 BUILD_ID 与当前时间
  async function loadBuildInfo() {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const p = path.join(process.cwd(), 'BUILD_INFO.json');
      const txt = await fs.readFile(p, 'utf8');
      const json = JSON.parse(txt);
      return json;
    } catch {
      return {
        buildId: process.env.BUILD_ID || 'unknown',
        time: new Date().toISOString(),
      } as any;
    }
  }

  app.get('/version', async (_req, reply) => {
    try {
      const info = await loadBuildInfo();
      return reply.send({
        ...info,
        service: 'cbt-api',
        env: process.env.NODE_ENV || 'production',
      });
    } catch (e: any) {
      return reply.status(500).send({ error: 'version_failed', message: e?.message });
    }
  });

  return app;
}

export async function start() {
  const app = await buildServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  try {
    await app.listen({ port, host });
    app.log.info(`API listening on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
// ESM 环境下直接启动
start();


