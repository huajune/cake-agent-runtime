#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 本地构建 + 推送部署
# 用法: pnpm run deploy [ssh-host]
# 默认 SSH host: haimian-deploy
#
# 流程: 本地预检 → 本地构建镜像 → 传输到服务器 → 部署 → 健康检查
# ============================================================

SSH_HOST="${1:-haimian-deploy}"
IMAGE_NAME="cake-agent-runtime"
GIT_SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
IMAGE_TAG="${IMAGE_TAG:-${GIT_SHORT_SHA}-${TIMESTAMP}}"
IMAGE_TAR="/tmp/${IMAGE_NAME}-${IMAGE_TAG}.tar"
REMOTE_IMAGE_TAR="/tmp/${IMAGE_NAME}-${IMAGE_TAG}.tar"
REMOTE_COMPOSE="/tmp/${IMAGE_NAME}-docker-compose.yml"
REMOTE_SCRIPT="/tmp/${IMAGE_NAME}-deploy-remote.sh"
RUNTIME_ENV_FILE=".env.production"

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  sed -n "s/^${key}=//p" "$file" | head -n1
}

API_GUARD_TOKEN="$(read_env_value API_GUARD_TOKEN "$RUNTIME_ENV_FILE")"
NEXT_PUBLIC_SUPABASE_URL="$(read_env_value NEXT_PUBLIC_SUPABASE_URL "$RUNTIME_ENV_FILE")"
NEXT_PUBLIC_SUPABASE_ANON_KEY="$(read_env_value NEXT_PUBLIC_SUPABASE_ANON_KEY "$RUNTIME_ENV_FILE")"

if [[ -z "$API_GUARD_TOKEN" ]]; then
  echo "❌ API_GUARD_TOKEN not found in ${RUNTIME_ENV_FILE}"
  exit 1
fi

if [[ -z "$NEXT_PUBLIC_SUPABASE_URL" ]]; then
  echo "❌ NEXT_PUBLIC_SUPABASE_URL not found in ${RUNTIME_ENV_FILE}"
  exit 1
fi

if [[ -z "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ]]; then
  echo "❌ NEXT_PUBLIC_SUPABASE_ANON_KEY not found in ${RUNTIME_ENV_FILE}"
  exit 1
fi

# ── Step 1: 本地预检 ────────────────────────────────────────
echo "🔍 Running pre-deploy checks..."

echo "  TypeScript type check..."
pnpm exec tsc --noEmit

echo "  Building web frontend..."
API_GUARD_TOKEN="$API_GUARD_TOKEN" \
NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
pnpm run build:web

echo "  Building..."
pnpm run build

echo "  Running tests..."
pnpm run test

echo "✅ Pre-deploy checks passed."

# ── Step 2: 本地构建 Docker 镜像 ────────────────────────────
echo ""
echo "🔨 Building Docker image locally (tag: ${IMAGE_TAG})..."
docker build \
  --platform linux/amd64 \
  --build-arg API_GUARD_TOKEN="${API_GUARD_TOKEN}" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL}" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  .

# ── Step 3: 导出并传输到服务器 ──────────────────────────────
echo "📦 Exporting image..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" -o "$IMAGE_TAR"

echo "🚀 Uploading to $SSH_HOST... ($(du -h "$IMAGE_TAR" | cut -f1))"
scp "$IMAGE_TAR" "${SSH_HOST}:${REMOTE_IMAGE_TAR}"
scp docker-compose.yml "${SSH_HOST}:${REMOTE_COMPOSE}"
scp scripts/deploy-remote.sh "${SSH_HOST}:${REMOTE_SCRIPT}"
rm -f "$IMAGE_TAR"

# ── Step 4: 服务器上加载镜像并部署 ──────────────────────────
echo "📡 Deploying on $SSH_HOST (tag: ${IMAGE_TAG})..."
ssh "$SSH_HOST" "chmod +x '$REMOTE_SCRIPT' && '$REMOTE_SCRIPT' --mode load --image-name '$IMAGE_NAME' --image-tag '$IMAGE_TAG' --workdir '/data/cake' --compose-source '$REMOTE_COMPOSE' --image-tar '$REMOTE_IMAGE_TAR'"
