#!/usr/bin/env bash
# Cross-build every Docker-built service in docker-compose.yml for
# linux/amd64 (Mac arm64 → Ubuntu amd64), bundle them into a single
# gzipped tarball, and print transfer/load instructions.
#
# Built services (matches docker-compose.yml):
#   - api                → ai-trader-api:latest             (apps/api)
#   - web                → ai-trader-web:latest             (apps/web, default target)
#   - drizzle-migrate    → ai-trader-drizzle-migrate:latest (apps/web, target=migrate)
#
# Bundled but not built: redis (redis:7-alpine, pulled for linux/amd64 so the
# server does not need registry access for the cache service).
#
# Not bundled (pulled on the server): postgres.
#
# Usage:
#   ./scripts/build-all-images.sh
#
# For a web-only rebuild (faster), use scripts/build-web-image.sh instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_CONTEXT="${REPO_ROOT}/apps/web"
API_CONTEXT="${REPO_ROOT}/apps/api"
OUT_DIR="${REPO_ROOT}/dist"
OUT_FILE="${OUT_DIR}/ai-trader-all.tar.gz"
PLATFORM="linux/amd64"

API_IMAGE="ai-trader-api:latest"
WEB_IMAGE="ai-trader-web:latest"
MIGRATE_IMAGE="ai-trader-drizzle-migrate:latest"
REDIS_IMAGE="redis:7-alpine"

mkdir -p "${OUT_DIR}"

echo "→ building ${API_IMAGE} for ${PLATFORM}"
docker buildx build \
  --platform "${PLATFORM}" \
  --tag "${API_IMAGE}" \
  --load \
  "${API_CONTEXT}"

echo "→ building ${WEB_IMAGE} for ${PLATFORM}"
docker buildx build \
  --platform "${PLATFORM}" \
  --tag "${WEB_IMAGE}" \
  --load \
  "${WEB_CONTEXT}"

echo "→ building ${MIGRATE_IMAGE} for ${PLATFORM} (target=migrate)"
docker buildx build \
  --platform "${PLATFORM}" \
  --target migrate \
  --tag "${MIGRATE_IMAGE}" \
  --load \
  "${WEB_CONTEXT}"

# A plain pull retags ${REDIS_IMAGE} to the amd64 variant on this machine, so
# the native one is pulled back after saving (the trap covers a failed save).
echo "→ pulling ${REDIS_IMAGE} for ${PLATFORM}"
docker pull --platform "${PLATFORM}" "${REDIS_IMAGE}"
trap 'echo "→ restoring native ${REDIS_IMAGE}"; docker pull --quiet "${REDIS_IMAGE}" >/dev/null' EXIT

echo "→ saving 4 images to ${OUT_FILE}"
docker save "${API_IMAGE}" "${WEB_IMAGE}" "${MIGRATE_IMAGE}" "${REDIS_IMAGE}" | gzip > "${OUT_FILE}"

SIZE="$(du -h "${OUT_FILE}" | cut -f1)"
echo
echo "✔ built and saved (${SIZE})"
echo "  ${OUT_FILE}"
echo
echo "──────────────────────────────────────────────────────────────────"
echo "Next steps — copy/paste, replace user@server with your target:"
echo "──────────────────────────────────────────────────────────────────"
cat <<'EOF'

# 1. Transfer (one of these):
#
#    scp dist/ai-trader-all.tar.gz user@server:~/
#
#    # or sftp:
#    sftp user@server
#    > put dist/ai-trader-all.tar.gz
#    > bye
#
#    # or stream straight in (no temp file on server):
#    cat dist/ai-trader-all.tar.gz | ssh -t user@server 'sudo docker load -i /dev/stdin'

# 2. On the server, load and recreate the stack:
#
#    ssh user@server
#    gunzip -c ~/ai-trader-all.tar.gz | sudo docker load
#    rm ~/ai-trader-all.tar.gz
#    cd ~/ai-trader && git pull --ff-only
#    sudo docker compose up -d --no-build --force-recreate

# 3. Verify (web is the usual canary since iteration happens there most):
#
#    sudo docker compose exec web ls /app/.output/server/chunks/_/holdings.mjs
#    # → should print the path. If "No such file or directory", the swap didn't take.
#
#    sudo docker compose ps
#    # → api + web should be Up, redis Up (healthy), drizzle-migrate Exited (0).

EOF
