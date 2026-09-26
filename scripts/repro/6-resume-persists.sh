#!/usr/bin/env bash
# Resuming an interrupted run appends its events after the existing ones:
# no seq collisions, and the resumed events are readable after a refresh.
. "$(dirname "$0")/lib.sh"
trap 'unstub_api; rm -f "$JAR"' EXIT

stub_api 20
login
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run="$(start_run AAPL)"
sleep 5
docker compose restart api >/dev/null
wait_status "$run" failed 30
before="$(psql_q "select count(*) from agent_messages where run_id = '$run'")"
log "run $run interrupted with $before events"

stub_api 5
api -H 'content-type: application/json' -d "{\"run_id\":\"$run\"}" "$BASE/api/research/agents-resume" >/dev/null
wait_status "$run" complete 60

seqs="$(psql_q "select string_agg(seq::text, ',' order by seq) from agent_messages where run_id = '$run'")"
after="$(psql_q "select count(*) from agent_messages where run_id = '$run'")"
expected="$(seq -s, 0 $((after - 1)))"
[ "$seqs" = "$expected" ] || fail "seqs are $seqs, expected $expected"
[ "$after" -gt "$before" ] || fail "no resumed events were persisted"
psql_q "select 1 from agent_messages where run_id = '$run' and kind = 'decision'" | grep -q 1 \
  || fail "the resumed decision is not persisted"
if docker compose logs --since "$since" web | grep agent_messages_run_seq_uq; then
  fail "web logged seq collisions"
fi
pass "run $run resumed: $before -> $after events, seqs contiguous"
