# Shared helpers for the debate repro scripts. Source it; do not run it.
# Expects the compose stack from the repo root and reads .env for the
# password, web port, and Postgres credentials.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

BASE="http://localhost:${WEB_PORT:-3000}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

STUB_COMPOSE=(docker compose -f docker-compose.yml -f scripts/repro/compose.stub.yml)

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

login() {
  curl -fsS -c "$JAR" -H 'content-type: application/json' \
    -d "{\"password\":\"${APP_PASSWORD}\"}" "$BASE/api/login" >/dev/null
}

api() { curl -fsS -b "$JAR" "$@"; }

psql_q() {
  docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
}

# Restart the api with the sleeping stub graph (AGENTS_STUB_RUN_SECONDS=$1).
stub_api() {
  AGENTS_STUB_RUN_SECONDS="$1" "${STUB_COMPOSE[@]}" up -d --force-recreate api >/dev/null
  for _ in $(seq 1 60); do
    docker compose exec -T api python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" \
      >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "api did not come back up"
}

# Put the api back to its normal configuration.
unstub_api() { docker compose up -d --force-recreate api >/dev/null; }

start_run() {
  api -H 'content-type: application/json' -d "{\"symbol\":\"$1\"}" "$BASE/api/research/agents-run" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])'
}

run_status() {
  api "$BASE/api/research/agent-runs?run_id=$1" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["rows"]; print(r[0]["status"] if r else "missing")'
}

# wait_status <run_id> <status> <timeout seconds>
wait_status() {
  local s
  for _ in $(seq 1 "$3"); do
    s="$(run_status "$1")"
    [ "$s" = "$2" ] && return 0
    sleep 1
  done
  fail "run $1 is '$s', expected '$2' within $3 s"
}
