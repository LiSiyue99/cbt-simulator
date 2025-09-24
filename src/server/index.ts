import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { registerSessionRoutes } from './routes/sessions';
import { registerThoughtRecordRoutes } from './routes/thoughtRecords';
import { registerAuthRoutes } from './routes/auth';
import { registerAssistantRoutes } from './routes/assistant';
import { registerQuestionRoutes } from './routes/questions';
import { registerFeedbackRoutes } from './routes/feedbacks';
import { registerAdminRoutes } from './routes/admin';
import { registerAssignmentRoutes } from './routes/assignments';
import authPlugin from './plugins/auth';
import { registerAssistantClassRoutes } from './routes/assistantClass';

export async function buildServer() {
  const app = Fastify({
    logger: true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  await app.register(authPlugin);

  await registerSessionRoutes(app);
  await registerThoughtRecordRoutes(app);
  await registerAuthRoutes(app);
  await registerAssistantRoutes(app);
  await registerQuestionRoutes(app);
  await registerFeedbackRoutes(app);
  await registerAdminRoutes(app);
  await registerAssignmentRoutes(app);
  await registerAssistantClassRoutes(app);

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


