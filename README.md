# cbt-simulator（后端）

Fastify + Drizzle 的后端服务，提供会话、作业与教学相关 API。

## 开发
```bash
npm ci
npm run db:up         # 可选：启动本地 Postgres (docker-compose)
cp docs/ENV.md .env   # 仅示例，实际请手动按需创建 .env
npm run dev:api
## 部署脚本（离线，无需 git pull）

已在 `scripts/` 目录新增两份本地触发脚本，对应 ECS 上的远端执行脚本样例：

- 本地执行：
  - `scripts/deploy-api-local.sh`：打包上传后端并触发远端部署（不执行数据库迁移）。
  - `scripts/deploy-web-local.sh`：打包上传前端并触发远端部署。

- 远端样例（需放到 ECS 并 `chmod +x`）：
  - `scripts/deploy-cbt-api.sample.sh` → `/root/bin/deploy-cbt-api.sh`
  - `scripts/deploy-cbt-web.sample.sh` → `/root/bin/deploy-cbt-web.sh`

使用流程：
1) 首次在 ECS 上把两份 `*.sample.sh` 放到 `/root/bin/` 并赋权：
   ```bash
   scp /path/to/deploy-cbt-*.sample.sh root@<ECS>:/root/bin/
   ssh root@<ECS> 'chmod +x /root/bin/deploy-cbt-*.sh'
   ```
2) 本地修改好代码后，直接运行：
   ```bash
   ./scripts/deploy-api-local.sh
   ./scripts/deploy-web-local.sh
   ```
3) 脚本会在 ECS 侧解包至版本目录、保留 `.env.production(.local)`，用 PM2 重启并做健康检查；失败自动回滚（后端脚本包含）。

注意：生产不执行数据库迁移；前端线上请使用 `.env.production(.local)` 并避免 `.env.local` 覆盖。

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
