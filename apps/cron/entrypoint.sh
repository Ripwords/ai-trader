#!/bin/sh
# Daily reflection trigger for the agents pipeline.
#
# Polls the system clock every 5 minutes; when the UTC hour matches
# SCHEDULE_HOUR_UTC (default 08), POSTs /agents/reflect on the api
# container. After firing, sleeps 1 hour so we don't re-trigger within
# the same hour window. Auth uses the same INTERNAL_BEARER as every
# other api->web hop in this stack.
set -e
SCHEDULE_HOUR_UTC="${SCHEDULE_HOUR_UTC:-08}"
echo "[agents-cron] scheduled hour UTC=$SCHEDULE_HOUR_UTC"
while true; do
  now_h=$(date -u +%H)
  if [ "$now_h" = "$SCHEDULE_HOUR_UTC" ]; then
    echo "[agents-cron] running reflect at $(date -u +%FT%TZ)"
    curl -fsS -X POST -H "Authorization: Bearer ${INTERNAL_BEARER}" \
      "http://api:8000/agents/reflect" || echo "[agents-cron] reflect failed"
    sleep 3600
  fi
  sleep 300
done
