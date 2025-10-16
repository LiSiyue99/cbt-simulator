# 部署手册（cbt-simulator）

本文档提供两条部署路径：Docker（推荐）与 PM2（非容器）。在生产环境请使用独立数据库（RDS/PostgreSQL）并开启 SSL。

## 一、准备工作
1. 数据库（RDS/PostgreSQL）
   - 创建数据库与业务账号
   - 获取连接串 `DATABASE_URL`（示例：`postgres://user:pass@rds.internal:5432/app_db?sslmode=require`）
   - 如需，准备 CA 证书并通过 `PGSSLROOTCERT`/`DATABASE_SSL_CA` 指定
2. 服务器（ECS）
   - 安装 Node 20（PM2 路径）或 Docker（Docker 路径）
   - 开放端口：80/443（由反向代理暴露），应用默认监听 3000
3. 环境变量
   - 参考 `docs/ENV.md`，准备 `.env.production` 或部署平台的环境配置

## 二、Docker 部署（推荐）
1. 构建镜像
```bash
docker build -t cbt-simulator:latest .
```
2. 初始化数据库（迁移）
```bash
docker run --rm --env-file .env.production cbt-simulator:latest \
  sh -lc "npm run dr:migrate"
```
3. 启动应用容器
```bash
docker run -d --name cbt-api -p 3000:3000 --env-file .env.production \
  --restart=always cbt-simulator:latest
```
4. 健康检查
- 进程存活：`GET /health?probe=liveness`
- 就绪（含 DB ping）：`GET /health`

## 三、PM2（非容器）
1. 安装依赖并构建
```bash
npm ci --omit=dev=false
npm run build
```
2. 运行迁移（使用生产 `DATABASE_URL`）
```bash
DATABASE_URL=postgres://... npm run dr:migrate
```
3. 启动（一次性）
```bash
npm run start:prod
```
4. PM2 守护（可选）
- 全局安装 PM2（或使用 npx）
```bash
npm i -g pm2
pm2 start dist/server/index.js --name cbt-api
pm2 save
pm2 startup   # 生成并执行系统自启命令
```
5. 日志与重启
```bash
pm2 logs cbt-api
pm2 restart cbt-api
```

## 四、反向代理（示例）
以 Nginx 为例：
```nginx
server {
  listen 80;
  server_name example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s; # AI 调用较长
  }
}
```
（建议使用 HTTPS 与证书自动续期）

## 五、运维建议
- 日志：结构化输出（pino/fastify）。
- 配置管理：使用 `.env.production` 或平台 Secret，避免入库。
- 迁移：与启动解耦，作为独立步骤触发。
- 健康检查：反代/SLB 配置存活与就绪探针。

## 六、回滚流程
- 非容器：
  1) 保留上一版构建产物（`dist/`）
  2) 切换启动为上一版：`pm2 restart cbt-api --update-env`（或直接 `node dist/server/index.js`）
  3) 如涉及破坏性迁移，优先评估是否需要数据库级回滚（建议仅在有备份/快照时执行）
- 容器：
  1) 保留上一版镜像 tag（如 `cbt-simulator:<tag>`）
  2) 回滚运行：
  ```bash
  docker stop cbt-api && docker rm cbt-api
  docker run -d --name cbt-api -p 3000:3000 --env-file .env.production cbt-simulator:<tag>
  ```
  3) 如涉及迁移：仅在必要且有备份时执行逆向迁移或恢复快照

## 七、常见问题
- 无法连接数据库：检查 `DATABASE_URL` 与 SSL 配置；必要时挂载 RDS CA。
- `/health` 503：DB 不可达或权限不足。
- 上游 AI 错误：确保 `DASHSCOPE_API_KEY(S)` 正确并有配额。
