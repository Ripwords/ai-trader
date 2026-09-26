#!/usr/bin/env bash
# A debate node that stays silent for 330 s must not cut the web->api stream.
# Heartbeats keep it alive and the run completes.
. "$(dirname "$0")/lib.sh"
trap 'unstub_api; rm -f "$JAR"' EXIT

stub_api 330
login
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run="$(start_run AAPL)"
log "run $run started; the stub node sleeps 330 s"
wait_status "$run" complete 420

if docker compose logs --since "$since" web | grep -E 'terminated|UND_ERR_BODY_TIMEOUT|no data from the agents service'; then
  fail "web logged a cut stream"
fi
pass "run $run completed through a 330 s silent node"
