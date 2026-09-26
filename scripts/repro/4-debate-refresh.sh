#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
trap 'unstub_api; rm -f "$JAR"' EXIT
stub_api 30
node scripts/repro/4-debate-refresh.mjs
