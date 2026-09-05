#!/usr/bin/env bash
# Cross-build every Docker-built service in docker-compose.yml for
# linux/amd64 (Mac arm64 → Ubuntu amd64), bundle them into a single
# gzipped tarball, and print transfer/load instructions.
#
# Built services (matches docker-compose.yml):
#   - api                → ai-trader-api:latest             (apps/api)
#   - web                → ai-trader-web:latest             (apps/web, default target)
#   - drizzle-migrate    → ai-trader-drizzle-migrate:latest (apps/web, target=migrate)
#   - agents-cron        → ai-trader-agents-cron:latest     (apps/cron)
#
# Not built (pulled on the server): postgres.
#
# Usage:
#   ./scripts/build-all-images.sh
#
# For a web-only rebuild (faster), use scripts/build-web-image.sh instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_CONTEXT="${REPO_ROOT}/apps/web"
API_CONTEXT="${REPO_ROOT}/apps/api"
CRON_CONTEXT="${REPO_ROOT}/apps/cron"
OUT_DIR="${REPO_ROOT}/dist"
OUT_FILE="${OUT_DIR}/ai-trader-all.tar.gz"
PLATFORM="linux/amd64"

API_IMAGE="ai-trader-api:latest"
WEB_IMAGE="ai-trader-web:latest"
MIGRATE_IMAGE="ai-trader-drizzle-migrate:latest"
CRON_IMAGE="ai-trader-agents-cron:latest"

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

echo "→ building ${CRON_IMAGE} for ${PLATFORM}"
docker buildx build \
  --platform "${PLATFORM}" \
  --tag "${CRON_IMAGE}" \
  --load \
  "${CRON_CONTEXT}"

echo "→ saving 4 images to ${OUT_FILE}"
docker save "${API_IMAGE}" "${WEB_IMAGE}" "${MIGRATE_IMAGE}" "${CRON_IMAGE}" | gzip > "${OUT_FILE}"

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
#    # → api + web + agents-cron should be Up, drizzle-migrate should be Exited (0).

EOF
