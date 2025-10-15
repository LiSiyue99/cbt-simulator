import type { FastifyInstance } from 'fastify';

export async function registerFeedbackRoutes(app: FastifyInstance) {
  // 根据新设计：单独的“反馈”实体已被聊天消息替代
  // 保留空注册以兼容旧路由引用，但不再暴露具体处理逻辑
}
