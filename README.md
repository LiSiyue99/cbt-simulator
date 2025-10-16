# cbt-simulator（后端）

Fastify + Drizzle 的后端服务，提供会话、作业与教学相关 API。

## 开发
```bash
npm ci
npm run db:up         # 可选：启动本地 Postgres (docker-compose)
cp docs/ENV.md .env   # 仅示例，实际请手动按需创建 .env
npm run dev:api
```
默认端口：`http://localhost:3000`

## 生产命令矩阵
- 构建：
```bash
npm run build
```
- 迁移：
```bash
DATABASE_URL=postgres://... npm run dr:migrate
```
- 启动（一次性）：
```bash
npm run start:prod
```
- PM2 守护（可选）：
```bash
pm2 start dist/server/index.js --name cbt-api && pm2 save
```
- Docker：
```bash
docker build -t cbt-simulator:latest .
docker run --rm --env-file .env.production cbt-simulator:latest sh -lc "npm run dr:migrate"
docker run -d --name cbt-api -p 3000:3000 --env-file .env.production cbt-simulator:latest
```

## 健康检查
- 进程存活：`GET /health?probe=liveness`
- 就绪（含 DB ping）：`GET /health`

更多细节见：`docs/ENV.md`、`docs/DEPLOYMENT.md`。
