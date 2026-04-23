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
IMAGE_TAR="/tmp/${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"
REMOTE_IMAGE_TAR="/tmp/${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"
REMOTE_COMPOSE="/tmp/${IMAGE_NAME}-docker-compose.yml"
REMOTE_SCRIPT="/tmp/${IMAGE_NAME}-deploy-remote.sh"
RUNTIME_ENV_FILE=".env.production"
GZIP_LEVEL="${DEPLOY_GZIP_LEVEL:-1}"
RUN_TESTS="${DEPLOY_RUN_TESTS:-true}"
DEPLOY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  sed -n "s/^${key}=//p" "$file" | head -n1
}

notify_deploy_result() {
  local exit_code="$1"
  local deploy_result="failure"
  local webhook_url="${PRIVATE_CHAT_MONITOR_WEBHOOK_URL:-${DEPLOY_NOTIFICATION_WEBHOOK_URL:-}}"
  local webhook_secret="${PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET:-${DEPLOY_NOTIFICATION_WEBHOOK_SECRET:-}}"
  local git_branch git_sha git_short_sha finished_at

  if [[ "$exit_code" -eq 0 ]]; then
    deploy_result="success"
  fi

  if [[ -z "$webhook_url" ]]; then
    webhook_url="$(read_env_value PRIVATE_CHAT_MONITOR_WEBHOOK_URL "$RUNTIME_ENV_FILE")"
  fi

  if [[ -z "$webhook_secret" ]]; then
    webhook_secret="$(read_env_value PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET "$RUNTIME_ENV_FILE")"
  fi

  if [[ -z "$webhook_url" ]]; then
    webhook_url="$(read_env_value DEPLOY_NOTIFICATION_WEBHOOK_URL "$RUNTIME_ENV_FILE")"
  fi

  if [[ -z "$webhook_secret" ]]; then
    webhook_secret="$(read_env_value DEPLOY_NOTIFICATION_WEBHOOK_SECRET "$RUNTIME_ENV_FILE")"
  fi

  if [[ -z "$webhook_url" ]]; then
    echo "ℹ️ Deploy notification skipped: PRIVATE_CHAT_MONITOR_WEBHOOK_URL is not configured."
    return 0
  fi

  git_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo local)"
  git_sha="$(git rev-parse HEAD 2>/dev/null || echo "")"
  git_short_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "$GIT_SHORT_SHA")"
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if ! PRIVATE_CHAT_MONITOR_WEBHOOK_URL="$webhook_url" \
    PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET="$webhook_secret" \
    DEPLOY_RESULT="$deploy_result" \
    RELEASE_TAG="$IMAGE_TAG" \
    DEPLOY_ENVIRONMENT="production" \
    DEPLOY_BRANCH="$git_branch" \
    DEPLOY_TRIGGER="local deploy" \
    DEPLOY_HOST="$SSH_HOST" \
    DEPLOY_SHA="$git_sha" \
    SHORT_SHA="$git_short_sha" \
    DEPLOY_STARTED_AT="$DEPLOY_STARTED_AT" \
    DEPLOY_FINISHED_AT="$finished_at" \
    node scripts/send-deploy-notification.js; then
    echo "⚠️ Deploy notification failed; deployment result was ${deploy_result}."
  fi
}

trap 'exit_code=$?; notify_deploy_result "$exit_code"; exit "$exit_code"' EXIT

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

echo "  Skipping duplicate local build steps (Docker build will compile frontend and backend)..."

if [[ "$RUN_TESTS" == "true" ]]; then
  echo "  Running tests..."
  pnpm run test
else
  echo "  Skipping tests (DEPLOY_RUN_TESTS=${RUN_TESTS})"
fi

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
echo "📦 Exporting image (gzip -${GZIP_LEVEL})..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip -"${GZIP_LEVEL}" > "$IMAGE_TAR"

echo "🚀 Uploading to $SSH_HOST... ($(du -h "$IMAGE_TAR" | cut -f1))"
scp -C "$IMAGE_TAR" "${SSH_HOST}:${REMOTE_IMAGE_TAR}"
scp -C docker-compose.yml "${SSH_HOST}:${REMOTE_COMPOSE}"
scp -C scripts/deploy-remote.sh "${SSH_HOST}:${REMOTE_SCRIPT}"
scp -C "$RUNTIME_ENV_FILE" "${SSH_HOST}:/data/cake/${RUNTIME_ENV_FILE}"
rm -f "$IMAGE_TAR"

# ── Step 4: 服务器上加载镜像并部署 ──────────────────────────
echo "📡 Deploying on $SSH_HOST (tag: ${IMAGE_TAG})..."
ssh "$SSH_HOST" "chmod +x '$REMOTE_SCRIPT' && '$REMOTE_SCRIPT' --mode load --image-name '$IMAGE_NAME' --image-tag '$IMAGE_TAG' --workdir '/data/cake' --compose-source '$REMOTE_COMPOSE' --image-tar '$REMOTE_IMAGE_TAR'"
