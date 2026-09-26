#!/usr/bin/env bash
# Restarting the api mid-run must end the run as failed within seconds,
# not leave it running forever.
. "$(dirname "$0")/lib.sh"
trap 'unstub_api; rm -f "$JAR"' EXIT

stub_api 120
login
run="$(start_run AAPL)"
log "run $run started"
sleep 5
[ "$(run_status "$run")" = running ] || fail "run is not running before the restart"

docker compose restart api >/dev/null
log "api restarted"
wait_status "$run" failed 30
error="$(api "$BASE/api/research/agent-runs?run_id=$run" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rows"][0]["error"])')"
pass "run $run failed after the api restart: $error"
