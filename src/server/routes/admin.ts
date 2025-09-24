import type { FastifyInstance } from 'fastify';
import { createDb } from '../../db/client';
import { assistantStudents, users, visitorInstances } from '../../db/schema';
import { eq } from 'drizzle-orm';

export async function registerAdminRoutes(app: FastifyInstance) {
  // 管理员绑定：助教-学生-实例
  app.post('/admin/assign-assistant', {
    schema: {
      body: {
        type: 'object',
        required: ['assistantEmail', 'studentEmail', 'visitorInstanceId'],
        properties: {
          assistantEmail: { type: 'string' },
          studentEmail: { type: 'string' },
          visitorInstanceId: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    (app as any).requireRole(req, ['admin']);
    const db = createDb();
    const { assistantEmail, studentEmail, visitorInstanceId } = req.body as any;

    const [assistant] = await db.select().from(users).where(eq(users.email as any, assistantEmail));
    const [student] = await db.select().from(users).where(eq(users.email as any, studentEmail));
    const [instance] = await db.select().from(visitorInstances).where(eq(visitorInstances.id as any, visitorInstanceId));
    if (!assistant || !student || !instance) return reply.status(400).send({ error: 'invalid payload' });

    const id = crypto.randomUUID();
    await db.insert(assistantStudents).values({ id, assistantId: assistant.id, studentId: student.id, visitorInstanceId, createdAt: new Date() } as any);
    return reply.send({ ok: true });
  });
}
