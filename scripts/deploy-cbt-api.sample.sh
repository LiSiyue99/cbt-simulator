#!/usr/bin/env bash
set -euo pipefail

# 这是一份远端部署脚本样例。请把它放到 ECS 上：/root/bin/deploy-cbt-api.sh 并 chmod +x。
# 作用：从本地上传的 tgz 包无缝部署后端（不执行数据库迁移）。

tgz="${1:-}"
[ -f "$tgz" ] || { echo "用法: $0 /opt/cbt/uploads/cbt-api-*.tgz"; exit 2; }

NVM="$HOME/.nvm/nvm.sh"
APP_ROOT="/opt/cbt/api"
RELEASE_ROOT="/opt/cbt/releases/api"
CURRENT_LINK="$APP_ROOT/current"
PM2_NAME="cbt-api"
HEALTH_URL="http://127.0.0.1:3000/health"

ts=$(date +%Y%m%d-%H%M%S)
RELEASE_DIR="${RELEASE_ROOT}/${ts}"
mkdir -p "$RELEASE_DIR"

tar -xzf "$tgz" -C "$RELEASE_DIR"

if [ -f "$CURRENT_LINK/.env.production" ]; then
  cp -f "$CURRENT_LINK/.env.production" "$RELEASE_DIR/.env.production"
fi

if [ -s "$NVM" ]; then . "$NVM"; nvm use 20 >/dev/null; fi
cd "$RELEASE_DIR"
npm ci

# 生成构建信息文件，供 /version 读取
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
BUILD_ID="${ts}-${GIT_SHA}"
cat > "$RELEASE_DIR/BUILD_INFO.json" << EOF
{
  "buildId": "$BUILD_ID",
  "release": "$RELEASE_DIR",
  "time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# 若环境文件中未包含 BUILD_ID，则追加（兜底）
if [ -f "$RELEASE_DIR/.env.production" ] && ! grep -q '^BUILD_ID=' "$RELEASE_DIR/.env.production"; then
  echo "BUILD_ID=$BUILD_ID" >> "$RELEASE_DIR/.env.production"
fi

cat > "$RELEASE_DIR/run-api.sh" <<'EOS'
#!/usr/bin/env bash
set -e
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v nvm >/dev/null && nvm use 20 >/dev/null || true
cd "$(dirname "$0")"
exec ./node_modules/.bin/tsx src/server/index.ts
EOS
chmod +x "$RELEASE_DIR/run-api.sh"

# 确保 releases/current 结构并将 current 指向最新
mkdir -p "$APP_ROOT" "$RELEASE_ROOT"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  echo "发现 $CURRENT_LINK 为实体目录，备份后改为软链结构"
  mv "$CURRENT_LINK" "${CURRENT_LINK}.bak-${ts}"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

pm2 describe "$PM2_NAME" >/dev/null 2>&1 && pm2 restart "$PM2_NAME" --update-env || pm2 start "$CURRENT_LINK/run-api.sh" --name "$PM2_NAME"
pm2 save >/dev/null || true

sleep 2
code=$(curl -sS -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
if [ "$code" != "200" ]; then
  echo "健康检查失败($code)"
  exit 1
fi
echo "后端部署完成：$RELEASE_DIR"


