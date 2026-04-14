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
    docker build \
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

write_deploy_env "$IMAGE_TAG"

if ! run_compose; then
  rollback_release || true
  exit 1
fi

if ! health_check; then
  rollback_release || true
  exit 1
fi

docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:latest"
rm -f "$COMPOSE_BACKUP_FILE" "$DEPLOY_ENV_BACKUP_FILE"
docker image prune -f >/dev/null 2>&1 || true
echo "Deploy successful! Current image tag: ${IMAGE_TAG}"
