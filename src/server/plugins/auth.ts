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

  app.decorate('requireRole', function (this: FastifyInstance, req: any, roles: string[], opts?: { classId?: number }) {
    const payload = req.auth as AuthPayload;
    const hasRole = (p?: JwtPayload | null) => {
      if (!p) return false;
      if (p.role && roles.includes(p.role)) return true;
      if (p.roles && p.roles.some(r => roles.includes(r))) return true;
      return false;
    };
    if (!hasRole(payload)) {
      const err: any = new Error('forbidden');
      (err.statusCode as any) = 403;
      throw err;
    }
    // 可选班级作用域校验（针对 assistant_class 等）
    if (opts?.classId !== undefined && payload?.classScopes && roles.includes('assistant_class')) {
      const ok = payload.classScopes.some(s => s.role === 'assistant_class' && (s.classId === undefined || s.classId === opts.classId));
      if (!ok) {
        const err: any = new Error('forbidden');
        (err.statusCode as any) = 403;
        throw err;
      }
    }
    return payload;
  });
} as any);
