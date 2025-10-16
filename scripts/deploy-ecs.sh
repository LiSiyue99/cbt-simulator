#!/usr/bin/env bash
set -euo pipefail

# 一键部署脚本：将后端（Fastify）与前端域名、Nginx、证书、PM2 全部自动化
# 运行环境：在本机（macOS）项目根目录执行
# 依赖：ssh、scp、tar、brew（用于安装 sshpass，如需要）

########################################
# 必填参数（请按需修改后运行）
########################################
ECS_HOST="${ECS_HOST:-60.205.189.9}"
ECS_USER="${ECS_USER:-root}"
ECS_SSH_PORT=${ECS_SSH_PORT:-22}
ECS_PASSWORD="${ECS_PASSWORD:-fwwc&832Nn!67at}"
# 如需使用 SSH 私钥登录，请设置本地环境变量 ECS_SSH_KEY 为私钥路径
ECS_SSH_KEY="${ECS_SSH_KEY:-}"

# 域名与证书路径（本机路径）
API_DOMAIN="${API_DOMAIN:-api.aiforcbt.online}"
WEB_DOMAIN="${WEB_DOMAIN:-aiforcbt.online}"
WEB_DOMAIN_ALT="${WEB_DOMAIN_ALT:-www.aiforcbt.online}"

# 请将以下路径替换为你本机上实际的证书与私钥文件
# 证书必须包含完整链；私钥文件与证书配套
API_CERT_PEM="${API_CERT_PEM:-$HOME/certs/api.aiforcbt.online.pem}"
API_CERT_KEY="${API_CERT_KEY:-$HOME/certs/api.aiforcbt.online.key}"
WEB_CERT_PEM="${WEB_CERT_PEM:-$HOME/certs/aiforcbt.online.pem}"
WEB_CERT_KEY="${WEB_CERT_KEY:-$HOME/certs/aiforcbt.online.key}"

# Postgres CA 证书（本机路径 → 远端路径）
PG_CA_LOCAL="${PG_CA_LOCAL:-ApsaraDB-CA-Chain/ApsaraDB-CA-Chain.pem}"
PG_CA_REMOTE="${PG_CA_REMOTE:-/etc/ssl/certs/ApsaraDB-CA-Chain.pem}"

# 远端目录
APP_NAME="cbt-simulator"
REMOTE_DIR="/srv/${APP_NAME}"
REMOTE_CERT_DIR="/etc/nginx/certs"
REMOTE_STATIC_DIR="/srv/www"

# 前端站点模式：
#   nginx_static  → 直接由 Nginx 提供静态站点（默认）
#   node_proxy    → 反向代理到 127.0.0.1:3001（若你有前端 Node 服务）
FRONT_MODE="${FRONT_MODE:-nginx_static}"

# 前端本地构建目录（可选）：
# 将其设置为你的前端打包输出目录（例如 ./dist 或 ./build），脚本会自动打包并上传到远端静态根。
# 若未设置，则使用项目内的 web/ 目录（如存在）。
FRONT_LOCAL_DIR="${FRONT_LOCAL_DIR:-}"

# 未显式提供 FRONT_LOCAL_DIR 时，自动探测常见构建输出目录
if [[ -z "${FRONT_LOCAL_DIR}" ]]; then
  CANDIDATES=(
    "frontend/dist" "frontend/build"
    "web/dist" "web/build"
    "dist" "build"
    "apps/web/dist" "apps/web/build"
    "packages/web/dist" "packages/web/build"
  )
  for d in "${CANDIDATES[@]}"; do
    if [[ -d "$d" ]]; then
      FRONT_LOCAL_DIR="$d"
      echo "[+] 自动识别前端构建目录: $FRONT_LOCAL_DIR"
      break
    fi
  done
  if [[ -z "${FRONT_LOCAL_DIR}" ]]; then
    # 若项目包含 web/ 作为静态目录，远端将使用该目录；此处仅提示
    if [[ -d "web" ]]; then
      echo "[=] 未找到构建输出目录，将在远端使用项目内 web/ 作为静态资源（如存在）"
    else
      echo "[=] 未找到构建输出目录，也未检测到 web/，将部署占位页。"
    fi
  fi
fi

# 是否在部署后执行 Drizzle 数据库迁移（谨慎使用）
RUN_MIGRATIONS=0

########################################
# 工具函数
########################################
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# 检查远端 SSH（按当前认证方式）是否可用，不可用则提前提示并退出
ensure_remote_access() {
  echo "[+] 检查远端 SSH 可用性..."
  if ! sshp "echo ok" >/dev/null 2>&1; then
    if [[ -n "${ECS_SSH_KEY:-}" ]]; then
      cat <<'MSG'
[x] 私钥登录失败。请检查：
- 该公钥是否已添加到远端 ~/.ssh/authorized_keys
- 私钥权限是否为 600（或 400）：chmod 600 /path/to/key
- 远端 /etc/ssh/sshd_config 是否允许 PubkeyAuthentication yes
MSG
    else
      cat <<'MSG'
[x] 无法通过密码 SSH 登录到远端。
请在 ECS 上开启密码登录或配置密钥登录后重试：
1) 开启密码登录（在 ECS 控制台/VNC 中执行）：
   sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
   sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
   sudo systemctl restart sshd || sudo service ssh restart
2) 或配置 SSH 密钥登录，并在本机使用 ssh -i <key> 连接。
MSG
    fi
    exit 1
  fi
}

# 在目录中自动识别证书与私钥文件（优先 fullchain/bundle/cert 与 privkey/private）
resolve_cert_from_dir() {
  local dir="$1"
  local pem=""
  local key=""
  for candidate in fullchain.pem chain.pem bundle.pem cert.pem *.pem; do
    if [[ -f "$dir/$candidate" ]]; then pem="$dir/$candidate"; break; fi
  done
  for candidate in privkey.key private.key *.key; do
    if [[ -f "$dir/$candidate" ]]; then key="$dir/$candidate"; break; fi
  done
  echo "$pem|$key"
}

install_sshpass_if_needed() {
  # 若使用私钥登录，跳过 sshpass 安装
  if [[ -n "${ECS_SSH_KEY:-}" && -f "$ECS_SSH_KEY" ]]; then
    echo "[+] 将使用私钥登录，跳过 sshpass 安装"
    return
  fi
  if have_cmd sshpass; then
    echo "[+] sshpass 已安装"
    return
  fi
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "[+] 正在通过 Homebrew 安装 sshpass..."
    if ! have_cmd brew; then
      echo "[x] 未检测到 brew，请先安装 Homebrew: https://brew.sh" >&2
      exit 1
    fi
    # 官方源不提供 sshpass，使用第三方 Tap
    brew tap hudochenkov/sshpass || true
    brew install hudochenkov/sshpass/sshpass
  else
    echo "[!] 非 macOS 环境，若未安装 sshpass，将使用交互式 ssh/scp（需要手动输入密码）"
  fi
}

sshp() { # ssh 包装，优先使用私钥，其次 sshpass，无则回退到交互模式
  if [[ -n "${ECS_SSH_KEY:-}" && -f "$ECS_SSH_KEY" ]]; then
    chmod 600 "$ECS_SSH_KEY" || true
    ssh -i "$ECS_SSH_KEY" \
      -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=no \
      -o PreferredAuthentications=publickey \
      -o PubkeyAuthentication=yes \
      -p "$ECS_SSH_PORT" "$ECS_USER@$ECS_HOST" "$@"
  elif have_cmd sshpass; then
    sshpass -p "$ECS_PASSWORD" ssh \
      -o StrictHostKeyChecking=no \
      -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no \
      -p "$ECS_SSH_PORT" "$ECS_USER@$ECS_HOST" "$@"
  else
    ssh -o StrictHostKeyChecking=no -p "$ECS_SSH_PORT" "$ECS_USER@$ECS_HOST" "$@"
  fi
}

scpp() { # scp 包装，优先使用私钥，其次 sshpass，无则回退到交互模式
  local src="$1"; shift
  local dest="$1"; shift
  if [[ -n "${ECS_SSH_KEY:-}" && -f "$ECS_SSH_KEY" ]]; then
    chmod 600 "$ECS_SSH_KEY" || true
    scp -i "$ECS_SSH_KEY" \
      -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=no \
      -o PreferredAuthentications=publickey \
      -o PubkeyAuthentication=yes \
      -P "$ECS_SSH_PORT" "$src" "$dest"
  elif have_cmd sshpass; then
    sshpass -p "$ECS_PASSWORD" scp \
      -o StrictHostKeyChecking=no \
      -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no \
      -P "$ECS_SSH_PORT" "$src" "$dest"
  else
    scp -o StrictHostKeyChecking=no -P "$ECS_SSH_PORT" "$src" "$dest"
  fi
}

########################################
# 预检
########################################
echo "[+] 预检本机依赖..."
for c in ssh scp tar sed; do
  if ! have_cmd "$c"; then
    echo "[x] 缺少命令: $c" >&2
    exit 1
  fi
done

install_sshpass_if_needed
ensure_remote_access

echo "[+] 检查远端已存在的证书/CA..."
REMOTE_API_CERT_EXISTS=$(sshp "if [ -f '$REMOTE_CERT_DIR/api.pem' ] && [ -f '$REMOTE_CERT_DIR/api.key' ]; then echo 1; else echo 0; fi" || echo 0)
REMOTE_WEB_CERT_EXISTS=$(sshp "if [ -f '$REMOTE_CERT_DIR/web.pem' ] && [ -f '$REMOTE_CERT_DIR/web.key' ]; then echo 1; else echo 0; fi" || echo 0)
REMOTE_PG_CA_EXISTS=$(sshp "if [ -f '$PG_CA_REMOTE' ]; then echo 1; else echo 0; fi" || echo 0)

# 若本地提供的是目录，自动解析其中的 pem 与 key
API_CERT_PEM_PATH="$API_CERT_PEM"
API_CERT_KEY_PATH="${API_CERT_KEY:-}"
WEB_CERT_PEM_PATH="$WEB_CERT_PEM"
WEB_CERT_KEY_PATH="${WEB_CERT_KEY:-}"

if [[ -d "$API_CERT_PEM" ]]; then
  IFS='|' read -r a_pem a_key < <(resolve_cert_from_dir "$API_CERT_PEM")
  API_CERT_PEM_PATH="$a_pem"
  if [[ -z "$API_CERT_KEY_PATH" ]]; then API_CERT_KEY_PATH="$a_key"; fi
fi
if [[ -d "$WEB_CERT_PEM" ]]; then
  IFS='|' read -r w_pem w_key < <(resolve_cert_from_dir "$WEB_CERT_PEM")
  WEB_CERT_PEM_PATH="$w_pem"
  if [[ -z "$WEB_CERT_KEY_PATH" ]]; then WEB_CERT_KEY_PATH="$w_key"; fi
fi

if [[ "$REMOTE_PG_CA_EXISTS" != "1" ]]; then
  if [[ ! -f "$PG_CA_LOCAL" ]]; then
    echo "[x] 未找到 Postgres CA 文件: $PG_CA_LOCAL" >&2
    exit 1
  fi
else
  echo "[+] 远端已存在 PG CA，跳过本地上传校验"
fi

if [[ "$REMOTE_API_CERT_EXISTS" != "1" ]]; then
  if [[ -z "$API_CERT_PEM_PATH" || -z "$API_CERT_KEY_PATH" ]]; then
    echo "[x] API 证书目录/文件自动识别失败，请手动设置 API_CERT_PEM 与 API_CERT_KEY" >&2
    exit 1
  fi
  if [[ ! -f "$API_CERT_PEM_PATH" || ! -f "$API_CERT_KEY_PATH" ]]; then
    echo "[x] 未找到 API 证书或私钥：$API_CERT_PEM_PATH / $API_CERT_KEY_PATH" >&2
    exit 1
  fi
else
  echo "[+] 远端已存在 API 证书与私钥，跳过本地上传校验"
fi

if [[ "$REMOTE_WEB_CERT_EXISTS" != "1" ]]; then
  if [[ -z "$WEB_CERT_PEM_PATH" || -z "$WEB_CERT_KEY_PATH" ]]; then
    echo "[x] WEB 证书目录/文件自动识别失败，请手动设置 WEB_CERT_PEM 与 WEB_CERT_KEY" >&2
    exit 1
  fi
  if [[ ! -f "$WEB_CERT_PEM_PATH" || ! -f "$WEB_CERT_KEY_PATH" ]]; then
    echo "[x] 未找到 WEB 证书或私钥：$WEB_CERT_PEM_PATH / $WEB_CERT_KEY_PATH" >&2
    exit 1
  fi
else
  echo "[+] 远端已存在 WEB 证书与私钥，跳过本地上传校验"
fi

########################################
# 打包项目（排除无用内容）
########################################
TS=$(date +%Y%m%d-%H%M%S)
DEPLOY_TGZ="deploy-${APP_NAME}-${TS}.tar.gz"
echo "[+] 打包项目为 $DEPLOY_TGZ ..."
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.reports' \
  --exclude="$DEPLOY_TGZ" \
  -czf "$DEPLOY_TGZ" .

# 可选：打包本地前端构建目录
FRONT_LOCAL_TGZ=""
if [[ -n "${FRONT_LOCAL_DIR:-}" ]]; then
  if [[ -d "$FRONT_LOCAL_DIR" ]]; then
    FRONT_LOCAL_TGZ="front-dist-${TS}.tar.gz"
    echo "[+] 打包前端构建目录 $FRONT_LOCAL_DIR 为 $FRONT_LOCAL_TGZ"
    tar -czf "$FRONT_LOCAL_TGZ" -C "$FRONT_LOCAL_DIR" .
  else
    echo "[!] FRONT_LOCAL_DIR 不存在或不是目录：$FRONT_LOCAL_DIR"
  fi
fi

########################################
# 远端初始化目录
########################################
echo "[+] 初始化远端目录结构..."
sshp "mkdir -p '$REMOTE_DIR' '$REMOTE_CERT_DIR' '$REMOTE_STATIC_DIR' '/etc/nginx/conf.d' '/etc/ssl/certs'"

########################################
# 上传包与证书
########################################
echo "[+] 上传项目包与证书..."
scpp "$DEPLOY_TGZ" "$ECS_USER@$ECS_HOST:/tmp/$DEPLOY_TGZ"
if [[ -n "$FRONT_LOCAL_TGZ" && -f "$FRONT_LOCAL_TGZ" ]]; then
  echo "[+] 上传前端构建包 $FRONT_LOCAL_TGZ"
  scpp "$FRONT_LOCAL_TGZ" "$ECS_USER@$ECS_HOST:/tmp/$FRONT_LOCAL_TGZ"
fi
if [[ "$REMOTE_PG_CA_EXISTS" != "1" ]]; then
  scpp "$PG_CA_LOCAL" "$ECS_USER@$ECS_HOST:$PG_CA_REMOTE"
else
  echo "[=] 远端已有 PG CA，跳过上传"
fi
if [[ "$REMOTE_API_CERT_EXISTS" != "1" ]]; then
  scpp "$API_CERT_PEM_PATH" "$ECS_USER@$ECS_HOST:$REMOTE_CERT_DIR/api.pem"
  scpp "$API_CERT_KEY_PATH" "$ECS_USER@$ECS_HOST:$REMOTE_CERT_DIR/api.key"
else
  echo "[=] 远端已有 API 证书/私钥，跳过上传"
fi
if [[ "$REMOTE_WEB_CERT_EXISTS" != "1" ]]; then
  scpp "$WEB_CERT_PEM_PATH" "$ECS_USER@$ECS_HOST:$REMOTE_CERT_DIR/web.pem"
  scpp "$WEB_CERT_KEY_PATH" "$ECS_USER@$ECS_HOST:$REMOTE_CERT_DIR/web.key"
else
  echo "[=] 远端已有 WEB 证书/私钥，跳过上传"
fi

########################################
# 远端执行：安装基础环境、Node、pm2、tsx；解包；配置 .env；启动服务；配置 Nginx
########################################
echo "[+] 执行远端部署流程..."
sshp "DEPLOY_TGZ='$DEPLOY_TGZ' API_DOMAIN='$API_DOMAIN' WEB_DOMAIN='$WEB_DOMAIN' WEB_DOMAIN_ALT='$WEB_DOMAIN_ALT' PG_CA_REMOTE='$PG_CA_REMOTE' RUN_MIGRATIONS='$RUN_MIGRATIONS' FRONT_MODE='$FRONT_MODE' bash -s" <<'REMOTE_EOF'
set -euo pipefail

detect_pkg_mgr() {
  if command -v apt-get >/dev/null 2>&1; then echo apt; return; fi
  if command -v yum >/dev/null 2>&1; then echo yum; return; fi
  if command -v dnf >/dev/null 2>&1; then echo dnf; return; fi
  echo none
}

PKG_MGR=$(detect_pkg_mgr)
echo "[+] 包管理器: $PKG_MGR"

case "$PKG_MGR" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y || true
    apt-get install -y nginx curl git build-essential ca-certificates
    ;;
  yum)
    yum install -y epel-release || true
    yum install -y nginx curl git gcc gcc-c++ make ca-certificates || true
    systemctl enable nginx || true
    ;;
  dnf)
    dnf install -y nginx curl git gcc gcc-c++ make ca-certificates || true
    systemctl enable nginx || true
    ;;
  *)
    echo "[!] 未识别的包管理器，跳过 Nginx 安装。请确保系统已安装 Nginx。"
    ;;
esac

# 安装 nvm + Node + pm2 + tsx（若已安装将跳过）
if ! command -v node >/dev/null 2>&1; then
  echo "[+] 安装 Node via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
fi
if ! command -v pm2 >/dev/null 2>&1; then
  npm i -g pm2
fi
if ! command -v tsx >/dev/null 2>&1; then
  npm i -g tsx
fi

# 解压到远端目录
APP_NAME="cbt-simulator"
REMOTE_DIR="/srv/${APP_NAME}"
REMOTE_CERT_DIR="/etc/nginx/certs"
REMOTE_STATIC_DIR="/srv/www"
PG_CA_REMOTE="${PG_CA_REMOTE:-/etc/ssl/certs/ApsaraDB-CA-Chain.pem}"

echo "[+] 解包到 $REMOTE_DIR"
mkdir -p "$REMOTE_DIR"
tar -xzf "/tmp/$DEPLOY_TGZ" -C "$REMOTE_DIR"

cd "$REMOTE_DIR"

# 修复 .env：
# - 将 PGSSLROOTCERT 指向远端路径
# - 若密码包含 @，进行 URL 编码
# - 确保 PGSSLMODE=require 存在
if [[ -f .env ]]; then
  echo "[+] 检测到 .env，准备修正"
  DB_URL_ORIG=$(grep -E '^DATABASE_URL=' .env | sed 's/^DATABASE_URL=//') || true
  PGSSL_ORIG=$(grep -E '^PGSSLROOTCERT=' .env | sed 's/^PGSSLROOTCERT=//') || true

  # 使用 Node 进行 URL 解析与密码编码
  if [[ -n "$DB_URL_ORIG" ]]; then
    DB_URL_FIX=$(node -e 'const u=new URL(process.argv[1]); if(u.password) u.password=encodeURIComponent(decodeURIComponent(u.password)); console.log(u.toString())' "$DB_URL_ORIG" )
  else
    DB_URL_FIX=""
  fi

  # 生成新的 .env（保留原其他项）
  awk 'BEGIN{FS=OFS="="}
       /^DATABASE_URL=/ {next}
       /^PGSSLROOTCERT=/ {next}
       /^PGSSLMODE=/ {next}
       {print}
      ' .env > .env.tmp || true

  {
    if [[ -n "$DB_URL_FIX" ]]; then echo "DATABASE_URL=$DB_URL_FIX"; fi
    echo "PGSSLROOTCERT=$PG_CA_REMOTE"
    echo "PGSSLMODE=require"
  } >> .env.tmp

  mv .env.tmp .env
else
  echo "[!] 未找到 .env，将创建基础文件（请后续手动填充密钥）"
  cat > .env <<EOF_ENV
HOST=0.0.0.0
PORT=3000
PGSSLROOTCERT=${PG_CA_REMOTE}
PGSSLMODE=require
# 请手动添加 DASHSCOPE_API_KEYS 或 DASHSCOPE_API_KEY 等密钥
EOF_ENV
fi

# 复制/解压前端静态资源（仅在 FRONT_MODE=nginx_static）
if [[ "${FRONT_MODE:-nginx_static}" == "nginx_static" ]]; then
  mkdir -p "$REMOTE_STATIC_DIR"
  FRONT_TGZ_LATEST=$(ls -t /tmp/front-dist-*.tar.gz 2>/dev/null | head -n1 || true)
  if [[ -n "${FRONT_TGZ_LATEST:-}" && -f "$FRONT_TGZ_LATEST" ]]; then
    echo "[+] 使用上传的前端构建包部署到 $REMOTE_STATIC_DIR: $FRONT_TGZ_LATEST"
    rm -rf "$REMOTE_STATIC_DIR"/* || true
    tar -xzf "$FRONT_TGZ_LATEST" -C "$REMOTE_STATIC_DIR"
  elif [[ -d "$REMOTE_DIR/web" ]]; then
    echo "[+] 复制项目内 web/ 静态资源到 $REMOTE_STATIC_DIR"
    rm -rf "$REMOTE_STATIC_DIR"/* || true
    cp -r "$REMOTE_DIR/web"/* "$REMOTE_STATIC_DIR"/ || true
  else
    echo "[=] 未检测到前端构建包或 web/ 目录，保留占位静态页"
  fi
fi

# 安装依赖（包含 dev，确保 drizzle/tsx 可用）
npm install --legacy-peer-deps

# 可选：数据库迁移
RUN_MIGRATIONS=${RUN_MIGRATIONS:-0}
if [[ "$RUN_MIGRATIONS" == "1" ]]; then
  echo "[+] 运行数据库迁移 drizzle-kit migrate"
  npx drizzle-kit migrate
fi

# 启动后端（Fastify）
echo "[+] 使用 PM2 启动后端 API（tsx）"
pm2 delete cbt-api || true
pm2 start "tsx src/server/index.ts" --name cbt-api --cwd "$REMOTE_DIR"
pm2 save

# 写入 Nginx 配置
echo "[+] 写入 Nginx 站点配置"
API_DOMAIN="${API_DOMAIN:-api.aiforcbt.online}"
WEB_DOMAIN="${WEB_DOMAIN:-aiforcbt.online}"
WEB_DOMAIN_ALT="${WEB_DOMAIN_ALT:-www.aiforcbt.online}"

cat > /etc/nginx/conf.d/${API_DOMAIN}.conf <<EOF_API
server {
  listen 80;
  server_name ${API_DOMAIN};
  return 301 https://\$host\$request_uri;
}

server {
  listen 443 ssl http2;
  server_name ${API_DOMAIN};

  ssl_certificate ${REMOTE_CERT_DIR}/api.pem;
  ssl_certificate_key ${REMOTE_CERT_DIR}/api.key;
  ssl_protocols TLSv1.2 TLSv1.3;

  client_max_body_size 50m;

  location / {
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass http://127.0.0.1:3000;
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
  }
}
EOF_API

# 前端：默认静态托管；如需 Node 代理，请将 FRONT_MODE 设置为 node_proxy 并自行启动 3001 服务
cat > /etc/nginx/conf.d/${WEB_DOMAIN}.conf <<EOF_WEB
server {
  listen 80;
  server_name ${WEB_DOMAIN} ${WEB_DOMAIN_ALT};
  return 301 https://\$host\$request_uri;
}

server {
  listen 443 ssl http2;
  server_name ${WEB_DOMAIN} ${WEB_DOMAIN_ALT};

  ssl_certificate ${REMOTE_CERT_DIR}/web.pem;
  ssl_certificate_key ${REMOTE_CERT_DIR}/web.key;
  ssl_protocols TLSv1.2 TLSv1.3;

  # 默认静态模式
  root ${REMOTE_STATIC_DIR};
  index index.html;

  location / {
    try_files \$uri \$uri/ /index.html;
  }
}
EOF_WEB

# 清理历史重复配置（避免 server_name 冲突导致的重复加载）
cleanup_conf() {
  local domain="$1"
  for file in /etc/nginx/conf.d/*.conf; do
    [[ -f "$file" ]] || continue
    if grep -qE "server_name[[:space:]]+.*\b${domain}\b" "$file"; then
      local base
      base=$(basename "$file")
      if [[ "$base" != "${API_DOMAIN}.conf" && "$base" != "${WEB_DOMAIN}.conf" ]]; then
        echo "[=] 移除重复 Nginx 配置: $file"
        rm -f "$file"
      fi
    fi
  done
}
cleanup_conf "$API_DOMAIN"
cleanup_conf "$WEB_DOMAIN"
cleanup_conf "$WEB_DOMAIN_ALT"

# 提供一个占位静态页（如你有前端产物可替换）
if [[ ! -f ${REMOTE_STATIC_DIR}/index.html ]]; then
  cat > ${REMOTE_STATIC_DIR}/index.html <<EOF_IDX
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>aiforcbt.online</title>
    <style>body{font-family:system-ui,Arial,sans-serif;padding:2rem} code{background:#eee;padding:.2rem .4rem;border-radius:4px}</style>
  </head>
  <body>
    <h1>站点部署完成</h1>
    <p>前端静态页占位。如需替换，将你的前端构建产物放到 <code>${REMOTE_STATIC_DIR}</code>。</p>
    <p>后端 API 域名：<code>https://${API_DOMAIN}</code></p>
  </body>
</html>
EOF_IDX
fi

# 测试并重载 Nginx
if command -v nginx >/dev/null 2>&1; then
  nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart nginx
  else
    service nginx restart || /etc/init.d/nginx restart || nginx -s reload
  fi
else
  echo "[!] 未检测到 nginx 命令，跳过重载。"
fi

# PM2 开机自启
if command -v systemctl >/dev/null 2>&1; then
  pm2 startup -u root --hp /root || true
  pm2 save || true
fi

echo "[+] 远端部署完成"
REMOTE_EOF

echo "[✓] 全部完成！请在浏览器验证："
echo "    API:    https://${API_DOMAIN}"
echo "    前端:   https://${WEB_DOMAIN} (以及 https://${WEB_DOMAIN_ALT})"