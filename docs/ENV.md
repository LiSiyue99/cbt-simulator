# 后端环境变量说明（cbt-simulator）

请使用 `.env` 或通过部署平台注入以下变量；生产环境请勿将真实值提交到仓库。

## 必需变量
- `DATABASE_URL`: PostgreSQL 连接串，示例：
  - `postgres://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require`
- `JWT_SECRET`: 用于 JWT 签名的强随机字符串（生产必须覆盖默认值）。
- `DASHSCOPE_API_KEY` 或 `DASHSCOPE_API_KEYS`: Qwen/DashScope 密钥，单 Key 或逗号/空白分隔的 Key 列表（主 Key 在前）。

## 可选变量
- `PORT`（默认 `3000`）: 服务监听端口。
- `HOST`（默认 `0.0.0.0`）: 服务绑定地址。
- `RATELIMIT_MAX`（默认 `300`）: 每窗口内最大请求数。
- `RATELIMIT_WINDOW`（默认 `1 minute`）: 限流窗口，如 `1 minute`、`10 seconds`。
- `PGSSLROOTCERT` / `DATABASE_SSL_CA`: 数据库 CA 证书文件路径（建议生产开启 SSL）。
- `NODE_ENV`（建议 `production`）: 运行环境标识。

## 样例（本地/生产）
```bash
# 本地开发（示例）
DATABASE_URL=postgres://cbt:cbtpass@localhost:5455/cbt_db
JWT_SECRET=dev-change-me
DASHSCOPE_API_KEY=sk-xxxxxxxx
PORT=3000
HOST=0.0.0.0
RATELIMIT_MAX=300
RATELIMIT_WINDOW="1 minute"

# 生产（示例）
DATABASE_URL=postgres://app_user:xxxx@rds.internal:5432/app_db?sslmode=require
JWT_SECRET=prod-very-strong-random
DASHSCOPE_API_KEYS="sk-primary sk-backup-1 sk-backup-2"
NODE_ENV=production
# 若需：
#PGSSLROOTCERT=/etc/ssl/certs/rds-ca.pem
```
