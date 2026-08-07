#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy-remote.sh --mode build --image-tag TAG --compose-source PATH --source-dir PATH --api-guard-token TOKEN --supabase-url URL --supabase-anon-key KEY [options]
  deploy-remote.sh --mode load  --image-tag TAG --compose-source PATH --image-tar PATH [options]

Options:
  --mode            Deployment mode: build | load
  --image-name      Docker image name (default: cake-agent-runtime)
  --image-tag       Immutable image tag for this release
  --workdir         Remote deploy directory (default: /data/cake)
  --compose-source  Compose file to promote into workdir
  --source-dir      Source directory for docker build (required in build mode)
  --image-tar       Docker tarball to load (required in load mode)
  --api-guard-token API guard token injected into the frontend build (required in build mode)
  --supabase-url    Supabase URL injected into the frontend build (required in build mode)
  --supabase-anon-key Supabase anon key injected into the frontend build (required in build mode)
EOF
}

read_env_value() {
  local key="$1"
  local file="$2"

  if [[ ! -f "$file" ]]; then
    return 0
  fi

  sed -n "s/^${key}=//p" "$file" | head -n1
}

MODE=""
IMAGE_NAME="cake-agent-runtime"
IMAGE_TAG=""
WORKDIR="/data/cake"
COMPOSE_SOURCE=""
SOURCE_DIR=""
IMAGE_TAR=""
API_GUARD_TOKEN=""
SUPABASE_URL=""
SUPABASE_ANON_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --image-name)
      IMAGE_NAME="$2"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --workdir)
      WORKDIR="$2"
      shift 2
      ;;
    --compose-source)
      COMPOSE_SOURCE="$2"
      shift 2
      ;;
    --source-dir)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --image-tar)
      IMAGE_TAR="$2"
      shift 2
      ;;
    --api-guard-token)
      API_GUARD_TOKEN="$2"
      shift 2
      ;;
    --supabase-url)
      SUPABASE_URL="$2"
      shift 2
      ;;
    --supabase-anon-key)
      SUPABASE_ANON_KEY="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$MODE" || -z "$IMAGE_TAG" || -z "$COMPOSE_SOURCE" ]]; then
  usage >&2
  exit 1
fi

if [[ "$MODE" != "build" && "$MODE" != "load" ]]; then
  echo "--mode must be either build or load" >&2
  exit 1
fi

if [[ "$MODE" == "build" ]]; then
  if [[ -z "$SOURCE_DIR" || -z "$API_GUARD_TOKEN" || -z "$SUPABASE_URL" || -z "$SUPABASE_ANON_KEY" ]]; then
    echo "build mode requires --source-dir, --api-guard-token, --supabase-url, and --supabase-anon-key" >&2
    exit 1
  fi
fi

if [[ "$MODE" == "load" && -z "$IMAGE_TAR" ]]; then
  echo "load mode requires --image-tar" >&2
  exit 1
fi

cd "$WORKDIR"

DEPLOY_ENV_FILE="${WORKDIR}/.deploy.env"
DEPLOY_ENV_BACKUP_FILE="${WORKDIR}/.deploy.env.rollback"
COMPOSE_FILE="${WORKDIR}/docker-compose.yml"
COMPOSE_BACKUP_FILE="${WORKDIR}/docker-compose.rollback.yml"
RUNTIME_ENV_FILE="${WORKDIR}/.env.production"
ROLLBACK_TAG="rollback"
HEALTH_ATTEMPTS=12
HEALTH_INTERVAL_SECONDS=5

backup_current_release() {
  local current_tag
  current_tag="$(read_env_value IMAGE_TAG "$DEPLOY_ENV_FILE")"

  if [[ -f "$COMPOSE_FILE" ]]; then
    cp "$COMPOSE_FILE" "$COMPOSE_BACKUP_FILE"
  fi

  if [[ -f "$DEPLOY_ENV_FILE" ]]; then
    cp "$DEPLOY_ENV_FILE" "$DEPLOY_ENV_BACKUP_FILE"
  fi

  if [[ -n "$current_tag" ]] && docker image inspect "${IMAGE_NAME}:${current_tag}" >/dev/null 2>&1; then
    docker tag "${IMAGE_NAME}:${current_tag}" "${IMAGE_NAME}:${ROLLBACK_TAG}"
    echo "Backed up current image ${IMAGE_NAME}:${current_tag} as ${IMAGE_NAME}:${ROLLBACK_TAG}"
    return
  fi

  if docker image inspect "${IMAGE_NAME}:latest" >/dev/null 2>&1; then
    docker tag "${IMAGE_NAME}:latest" "${IMAGE_NAME}:${ROLLBACK_TAG}"
    echo "Backed up current image ${IMAGE_NAME}:latest as ${IMAGE_NAME}:${ROLLBACK_TAG}"
  fi
}

write_deploy_env() {
  printf 'IMAGE_TAG=%s\n' "$1" > "$DEPLOY_ENV_FILE"
}

run_compose() {
  docker compose --env-file "$DEPLOY_ENV_FILE" up -d --force-recreate || return 1
}

dump_deployment_diagnostics() {
  echo "Deployment diagnostics before rollback:"
  docker compose --env-file "$DEPLOY_ENV_FILE" ps || true
  docker compose --env-file "$DEPLOY_ENV_FILE" logs --no-color --tail=200 || true
}

verify_image_runtime() {
  echo "Verifying runtime in ${IMAGE_NAME}:${IMAGE_TAG}..."
  docker run --rm --entrypoint node "${IMAGE_NAME}:${IMAGE_TAG}" -e '
    const major = Number(process.versions.node.split(".")[0]);
    console.log(`Image Node.js runtime: ${process.version}`);
    if (major < 22) {
      console.error("Node.js 22 or newer is required by production dependencies.");
      process.exit(1);
    }
  ' || return 1
}

health_check() {
  local health_port response
  health_port="$(read_env_value PORT "$RUNTIME_ENV_FILE")"
  health_port="${health_port:-8585}"

  echo "Waiting for health check on port ${health_port}..."
  for i in $(seq 1 "$HEALTH_ATTEMPTS"); do
    sleep "$HEALTH_INTERVAL_SECONDS"
    response="$(curl -sS "http://localhost:${health_port}/agent/health" || true)"
    if printf '%s' "$response" | grep -Eq '"status":"(healthy|degraded)"'; then
      echo "Health check passed after $((i * HEALTH_INTERVAL_SECONDS))s"
      return 0
    fi

    if [[ -n "$response" ]]; then
      echo "Attempt ${i}/${HEALTH_ATTEMPTS}: not ready yet. Response: $response"
    else
      echo "Attempt ${i}/${HEALTH_ATTEMPTS}: endpoint not reachable yet."
    fi
  done

  return 1
}

rollback_release() {
  echo "Deployment failed. Rolling back..."

  if [[ -f "$COMPOSE_BACKUP_FILE" ]]; then
    cp "$COMPOSE_BACKUP_FILE" "$COMPOSE_FILE"
  fi

  if [[ -f "$DEPLOY_ENV_BACKUP_FILE" ]]; then
    cp "$DEPLOY_ENV_BACKUP_FILE" "$DEPLOY_ENV_FILE"
  elif docker image inspect "${IMAGE_NAME}:${ROLLBACK_TAG}" >/dev/null 2>&1; then
    write_deploy_env "$ROLLBACK_TAG"
  else
    echo "No rollback env file or rollback image found." >&2
    return 1
  fi

  run_compose
  echo "Rolled back to previous release"
}

promote_compose() {
  cp "$COMPOSE_SOURCE" "$COMPOSE_FILE" || return 1
}

build_or_load_image() {
  if [[ "$MODE" == "build" ]]; then
    echo "Building ${IMAGE_NAME}:${IMAGE_TAG} from ${SOURCE_DIR}..."
    # --network=host：构建期依赖拉取走宿主机网络命名空间。
    #
    # 注意：本行最初按「docker0 网桥 MTU 导致 PMTUD 黑洞」的判断加入，该判断
    # 已被 v10.42.0 部署证伪——加了本行仍然同样失败。2026-08-07 生产机只读
    # 探测给出真实原因：registry.npmjs.org 与 registry-1.docker.io 均 HTTP 000、
    # connect=0.000000s、45s 超时（TCP 连接根本没建立，与 MTU 无关），而
    # api.github.com 与 registry.npmmirror.com 正常。真正的修复是 Dockerfile 里
    # 的 NPM_REGISTRY 换源。
    #
    # 本行之所以保留：那次 0.73s 连通 npmmirror 的实测是在**宿主机网络**上做的，
    # 保留它可让构建走完全相同、已被测量过的网络路径；容器经 docker0 能否同样
    # 连通 npmmirror 尚无实测证据，不做无依据的假设。
    # 待补测容器侧连通性、或服务器出站恢复后，应删除本行恢复构建期网络隔离。
    docker build \
      --network=host \
      --build-arg API_GUARD_TOKEN="${API_GUARD_TOKEN}" \
      --build-arg NEXT_PUBLIC_SUPABASE_URL="${SUPABASE_URL}" \
      --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY}" \
      -t "${IMAGE_NAME}:${IMAGE_TAG}" \
      "$SOURCE_DIR" || return 1
    return
  fi

  echo "Loading ${IMAGE_NAME}:${IMAGE_TAG} from ${IMAGE_TAR}..."
  case "$IMAGE_TAR" in
    *.tar.gz|*.tgz)
      gzip -dc "$IMAGE_TAR" | docker load || return 1
      ;;
    *)
      docker load -i "$IMAGE_TAR" || return 1
      ;;
  esac
  rm -f "$IMAGE_TAR"
}

echo "Deploying ${IMAGE_NAME}:${IMAGE_TAG} in ${MODE} mode..."
backup_current_release

if ! promote_compose; then
  echo "Failed to update docker-compose.yml" >&2
  exit 1
fi

if ! build_or_load_image; then
  rollback_release || true
  exit 1
fi

if ! verify_image_runtime; then
  echo "Image runtime validation failed" >&2
  rollback_release || true
  exit 1
fi

write_deploy_env "$IMAGE_TAG"

if ! run_compose; then
  dump_deployment_diagnostics
  rollback_release || true
  exit 1
fi

if ! health_check; then
  dump_deployment_diagnostics
  rollback_release || true
  exit 1
fi

docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:latest"
rm -f "$COMPOSE_BACKUP_FILE" "$DEPLOY_ENV_BACKUP_FILE"
docker image prune -f >/dev/null 2>&1 || true
echo "Deploy successful! Current image tag: ${IMAGE_TAG}"
