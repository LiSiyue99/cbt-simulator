#!/usr/bin/env bash
set -euo pipefail

# 这是一份远端部署脚本样例。请把它放到 ECS 上：/root/bin/deploy-cbt-web.sh 并 chmod +x。
# 作用：从本地上传的 tgz 包无缝部署前端（Next.js）。

tgz="${1:-}"
[ -f "$tgz" ] || { echo "用法: $0 /opt/cbt/uploads/cbt-web-*.tgz"; exit 2; }

NVM="$HOME/.nvm/nvm.sh"
APP_ROOT="/opt/cbt/web"
RELEASE_ROOT="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
PM2_NAME="cbt-web"
HEALTH_URL="http://127.0.0.1:3001/api/health"

ts=$(date +%Y%m%d-%H%M%S)
RELEASE_DIR="${RELEASE_ROOT}/${ts}"
mkdir -p "$RELEASE_DIR"

tar -xzf "$tgz" -C "$RELEASE_DIR"

# 继承上一个 current 的生产环境变量（若存在）
if [ -f "$CURRENT_LINK/.env.production.local" ]; then
  cp -f "$CURRENT_LINK/.env.production.local" "$RELEASE_DIR/.env.production.local"
elif [ -f "$CURRENT_LINK/.env.production" ]; then
  cp -f "$CURRENT_LINK/.env.production" "$RELEASE_DIR/.env.production"
fi

# 禁止在生产使用 .env.local（构建期注入会被污染）
if [ -f "$RELEASE_DIR/.env.local" ]; then
  echo "检测到 .env.local，拒绝在生产构建使用。请改用 .env.production(.local)。"
  exit 3
fi

if [ -s "$NVM" ]; then . "$NVM"; nvm use 20 >/dev/null; fi
cd "$RELEASE_DIR"
npm ci
# 清理历史构建缓存，避免 Next/Turbopack 误读旧产物
rm -rf .next
# 生产强制使用非 Turbopack 构建
./node_modules/.bin/next build

# 输出 BUILD_ID 便于对齐
[ -f .next/BUILD_ID ] && echo "BUILD_ID=$(cat .next/BUILD_ID)"

# 确保 releases/current 结构存在，且 current 为软链
mkdir -p "$APP_ROOT" "$RELEASE_ROOT"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  echo "发现 $CURRENT_LINK 为实体目录，进行备份并纠偏为软链结构"
  mv "$CURRENT_LINK" "${CURRENT_LINK}.bak-${ts}"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

pm2 describe "$PM2_NAME" >/dev/null 2>&1 && pm2 restart "$PM2_NAME" --update-env || pm2 start "$CURRENT_LINK/node_modules/.bin/next" --name "$PM2_NAME" -- start -p 3001 --cwd "$CURRENT_LINK"
pm2 save >/dev/null || true

sleep 2
code=$(curl -sS -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
[ "$code" = "200" ] || { echo "前端健康检查失败($code)"; exit 1; }
echo "前端部署完成：$RELEASE_DIR"


