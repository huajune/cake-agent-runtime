#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 本地触发服务器部署（与 CI 流程一致）
# 用法: pnpm run deploy [ssh-host] [branch]
# 默认 SSH host: haimian-deploy, 默认分支: master
# ============================================================

SSH_HOST="${1:-haimian-deploy}"
BRANCH="${2:-master}"

echo "🚀 Deploying $BRANCH to $SSH_HOST..."
ssh "$SSH_HOST" bash -s -- "$BRANCH" << 'REMOTE_SCRIPT'
set -e
BRANCH="$1"
cd /data/cake

# 备份当前镜像用于回滚
if docker images cake-agent-runtime:latest --format '{{.ID}}' | grep -q .; then
  docker tag cake-agent-runtime:latest cake-agent-runtime:previous
  echo "Backed up current image as cake-agent-runtime:previous"
fi

# 拉取最新代码
if [ -d source/.git ]; then
  cd source && git fetch --depth 1 origin "$BRANCH" && git reset --hard origin/"$BRANCH" && cd ..
else
  rm -rf source
  git clone --depth 1 --branch "$BRANCH" https://github.com/huajune/cake-agent-runtime.git source
fi

# 在服务器上构建镜像
docker build -t cake-agent-runtime:latest ./source

# 启动新容器
docker compose up -d

# 健康检查（最多等 60 秒）
echo "Waiting for health check..."
for i in $(seq 1 12); do
  sleep 5
  if curl -sf http://localhost:8585/agent/health | grep -q '"status":"healthy"'; then
    echo "Health check passed after $((i*5))s"
    docker rmi cake-agent-runtime:previous 2>/dev/null || true
    docker image prune -f
    echo "Deploy successful!"
    exit 0
  fi
  echo "Attempt $i/12: not healthy yet..."
done

echo "Health check failed! Rolling back..."
if docker images cake-agent-runtime:previous --format '{{.ID}}' | grep -q .; then
  docker tag cake-agent-runtime:previous cake-agent-runtime:latest
  docker compose up -d
  echo "Rolled back to previous version"
fi
exit 1
REMOTE_SCRIPT
