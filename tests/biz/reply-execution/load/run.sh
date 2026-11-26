#!/usr/bin/env bash
# Run against fresh Docker containers on loopback. The application must be built beforehand.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
suite="$root/tests/biz/reply-execution/load"
out=$(mktemp -d "${TMPDIR:-/tmp}/cake-reply-load.XXXXXXXX")
suffix=$(basename "$out" | tr '[:upper:].' '[:lower:]-')
pg="cake-runtime-pg-$suffix"
redis="cake-redis-$suffix"
rest="cake-rest-$suffix"
database=cake_projection_reply_load_1589
deps=$(cd "$root/node_modules" && pwd -P)
cleanup() {
  for name in "${containers[@]}"; do docker stop "$name" >/dev/null || true; done
}
test -f "$root/dist/biz/action-execution/action-executor.service.js"
echo "Results: $out"
npm install --prefix "$out/deps" --ignore-scripts --no-audit --no-fund pg@8.16.3
docker run --rm -d --name "$pg" --network none --cpus 2 --memory 2g \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine -c max_connections=120 \
  -c shared_buffers=256MB -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on
containers=("$pg")
trap cleanup EXIT
for attempt in {1..30}; do
  if docker exec "$pg" pg_isready -U postgres >/dev/null; then break; fi
  sleep 1
done
python3 "$root/tests/biz/action-execution/verify-runtime-postgres.py" --container "$pg" \
  --database cake_projection_load_template --output "$out/schema" > "$out/schema.log"
docker exec "$pg" createdb -U postgres -T cake_projection_load_template "$database"
migrations="$root/supabase/migrations"
{
  awk '/^CREATE OR REPLACE FUNCTION public.action_body_storage_state/{keep=1}
       /^REVOKE ALL ON FUNCTION public.chat_payload_text_mask/{keep=0} keep' \
    "$migrations/20261124100000_runtime_body_compaction.sql"
  cat "$migrations/20261124100100_booking_accepted_work_order.sql" "$suite/seed.sql"
} | docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$database" > "$out/seed.log"
docker run --rm -d --name "$redis" --network "container:$pg" --cpus 1 --memory 256m \
  redis:6-alpine redis-server --bind 127.0.0.1 --appendonly no --save ''
containers=("$redis" "$pg")
docker run --rm -d --name "$rest" --network "container:$pg" --cpus 2 --memory 512m \
  -e "PGRST_DB_URI=postgres://postgres@127.0.0.1:5432/$database" \
  -e PGRST_DB_ANON_ROLE=service_role -e PGRST_DB_POOL=24 -e PGRST_DB_POOL_ACQUISITION_TIMEOUT=3 \
  -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_LOG_LEVEL=warn -e GHCRTS=-N2 postgrest/postgrest:v12.2.12
containers=("$rest" "$redis" "$pg")
drive() {
  docker run --rm --network "container:$pg" --cpus 3 --memory 2g \
    -e NODE_PATH=/bench/deps/node_modules -v "$root/dist:/bench/app/dist:ro" \
    -v "$deps:/bench/app/node_modules:ro" -v "$suite:/bench/load:ro" \
    -v "$out/deps/node_modules:/bench/deps/node_modules:ro" node:24-alpine node "/bench/load/$1.cjs" "${@:2}"
}
drive database smoke > "$out/smoke-db.json"
drive queue smoke > "$out/smoke-queue.json"
drive database > "$out/database.json"
drive queue > "$out/queue.json" 2> "$out/queue.log"
drive database repeat > "$out/repeated.json"
drive queue starts > "$out/queue-starts.json" 2> "$out/queue-starts.log"
docker exec -i "$pg" psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d "$database" \
  < "$suite/verify-receipts.sql" > "$out/receipt-audit.json"
python3 "$suite/queue_estimate.py" > "$out/estimate.json"
cat "$out"/{database,queue,repeated,queue-starts,receipt-audit,estimate}.json
