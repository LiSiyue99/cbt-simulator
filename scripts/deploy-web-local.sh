#!/usr/bin/env bash
set -euo pipefail

# 本地脚本：打包上传前端（web/）并触发远端部署（不依赖 git pull）

# === 可按需修改 ===
PEM="/Users/siyue/Downloads/ecs-root-2025.pem"
HOST="root@60.205.189.9"
SRC="/Users/siyue/Documents/GitHub/cbt-simulator-front/web"
REMOTE_UPLOAD_DIR="/opt/cbt/uploads"
REMOTE_SCRIPT="/root/bin/deploy-cbt-web.sh"
# ==================

ts=$(date +%Y%m%d-%H%M%S)
pkg="cbt-web-${ts}.tgz"
tmp="/tmp/${pkg}"

echo "[local] 打包前端代码 → ${tmp}"
tar -C "$SRC" -czf "$tmp" \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".next" \
  .

echo "[local] 上传到 ECS: ${HOST}:${REMOTE_UPLOAD_DIR}/"
ssh -i "$PEM" -o StrictHostKeyChecking=no "$HOST" "mkdir -p '$REMOTE_UPLOAD_DIR'"
scp -i "$PEM" -o StrictHostKeyChecking=no "$tmp" "$HOST:$REMOTE_UPLOAD_DIR/"

echo "[remote] 触发远端部署脚本: $REMOTE_SCRIPT $REMOTE_UPLOAD_DIR/$pkg"
ssh -i "$PEM" -o StrictHostKeyChecking=no "$HOST" "bash -lc '$REMOTE_SCRIPT $REMOTE_UPLOAD_DIR/$pkg'"

echo "[done] 前端部署触发完成：$pkg"


