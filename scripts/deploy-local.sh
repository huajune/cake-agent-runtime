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
IMAGE_TAR="/tmp/${IMAGE_NAME}.tar"

# ── Step 1: 本地预检 ────────────────────────────────────────
echo "🔍 Running pre-deploy checks..."

echo "  TypeScript type check..."
pnpm exec tsc --noEmit

echo "  Building..."
pnpm run build

echo "  Running tests..."
pnpm run test

echo "✅ Pre-deploy checks passed."

# ── Step 2: 本地构建 Docker 镜像 ────────────────────────────
echo ""
echo "🔨 Building Docker image locally..."
docker build --platform linux/amd64 -t ${IMAGE_NAME}:latest .

# ── Step 3: 导出并传输到服务器 ──────────────────────────────
echo "📦 Exporting image..."
docker save ${IMAGE_NAME}:latest -o "$IMAGE_TAR"

echo "🚀 Uploading to $SSH_HOST... ($(du -h "$IMAGE_TAR" | cut -f1))"
scp "$IMAGE_TAR" "${SSH_HOST}:/tmp/${IMAGE_NAME}.tar"
scp docker-compose.yml "${SSH_HOST}:/data/cake/docker-compose.yml"
rm -f "$IMAGE_TAR"

# ── Step 4: 服务器上加载镜像并部署 ──────────────────────────
echo "📡 Deploying on $SSH_HOST..."
ssh "$SSH_HOST" bash -s << 'REMOTE_SCRIPT'
set -euo pipefail
cd /data/cake

IMAGE_NAME="cake-agent-runtime"

# 备份当前镜像用于回滚
if docker images ${IMAGE_NAME}:latest --format '{{.ID}}' | grep -q .; then
  docker tag ${IMAGE_NAME}:latest ${IMAGE_NAME}:previous
  echo "Backed up current image as ${IMAGE_NAME}:previous"
fi

# 加载新镜像
docker load -i /tmp/${IMAGE_NAME}.tar
rm -f /tmp/${IMAGE_NAME}.tar

# 启动新容器
docker compose up -d

# 健康检查（最多等 60 秒）
HEALTH_PORT=$(grep -E '^PORT=' .env.prod 2>/dev/null | cut -d= -f2 || echo 8585)
echo "Waiting for health check on port ${HEALTH_PORT}..."
HEALTHY=false
for i in $(seq 1 12); do
  sleep 5
  if curl -sf "http://localhost:${HEALTH_PORT}/agent/health" | grep -q '"status":"healthy"'; then
    HEALTHY=true
    echo "Health check passed after $((i*5))s"
    break
  fi
  echo "Attempt $i/12: not healthy yet..."
done

if [ "$HEALTHY" = false ]; then
  echo "Health check failed! Rolling back..."
  if docker images ${IMAGE_NAME}:previous --format '{{.ID}}' | grep -q .; then
    docker tag ${IMAGE_NAME}:previous ${IMAGE_NAME}:latest
    docker compose up -d
    echo "Rolled back to previous version"
  fi
  exit 1
fi

# 部署成功，清理旧镜像
docker rmi ${IMAGE_NAME}:previous 2>/dev/null || true
docker image prune -f
echo "✅ Deploy successful!"
REMOTE_SCRIPT
