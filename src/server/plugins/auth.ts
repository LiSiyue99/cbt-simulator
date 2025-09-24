import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { verifyJwt, JwtPayload } from '../auth/jwt';

export type AuthPayload = JwtPayload | null;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPayload;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    const auth = req.headers['authorization'];
    if (!auth) {
      (req as any).auth = null;
      return;
    }
    const token = auth.toString().replace(/^Bearer\s+/i, '');
    (req as any).auth = await verifyJwt(token);
  });

  app.decorate('requireRole', function (this: FastifyInstance, req: any, roles: string[]) {
    const payload = req.auth as AuthPayload;
    if (!payload || !roles.includes((payload as any).role)) {
      const err: any = new Error('forbidden');
      (err.statusCode as any) = 403;
      throw err;
    }
    return payload;
  });
} as any);
