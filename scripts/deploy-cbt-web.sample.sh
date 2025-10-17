#!/usr/bin/env bash
set -euo pipefail

# 这是一份远端部署脚本样例。请把它放到 ECS 上：/root/bin/deploy-cbt-web.sh 并 chmod +x。
# 作用：从本地上传的 tgz 包无缝部署前端（Next.js）。

tgz="${1:-}"
[ -f "$tgz" ] || { echo "用法: $0 /opt/cbt/uploads/cbt-web-*.tgz"; exit 2; }

NVM="$HOME/.nvm/nvm.sh"
APP_LINK="/opt/cbt/web"
RELEASE_ROOT="/opt/cbt/releases/web"
PM2_NAME="cbt-web"
HEALTH_URL="http://127.0.0.1:3001/api/health"

ts=$(date +%Y%m%d-%H%M%S)
RELEASE_DIR="${RELEASE_ROOT}/${ts}"
mkdir -p "$RELEASE_DIR"

tar -xzf "$tgz" -C "$RELEASE_DIR"

if [ -f "$APP_LINK/.env.production.local" ]; then
  cp -f "$APP_LINK/.env.production.local" "$RELEASE_DIR/.env.production.local"
elif [ -f "$APP_LINK/.env.production" ]; then
  cp -f "$APP_LINK/.env.production" "$RELEASE_DIR/.env.production"
fi

if [ -s "$NVM" ]; then . "$NVM"; nvm use 20 >/dev/null; fi
cd "$RELEASE_DIR"
npm ci
npm run build

ln -sfn "$RELEASE_DIR" "$APP_LINK"
pm2 describe "$PM2_NAME" >/dev/null 2>&1 && pm2 restart "$PM2_NAME" --update-env || pm2 start "$APP_LINK/node_modules/.bin/next" --name "$PM2_NAME" -- start -p 3001 --cwd "$APP_LINK"
pm2 save >/dev/null || true

sleep 2
code=$(curl -sS -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
[ "$code" = "200" ] || { echo "前端健康检查失败($code)"; exit 1; }
echo "前端部署完成：$RELEASE_DIR"


