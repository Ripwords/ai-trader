#!/usr/bin/env bash
# Cross-build the apps/web Docker image for linux/amd64 (so it runs on
# x86 Ubuntu servers from an arm64 Mac), save it to a gzipped tarball
# next to this script, and print transfer/load instructions.
#
# Usage:
#   ./scripts/build-web-image.sh
#
# Then follow the commented commands at the bottom of this script's
# output to ship and load it on the target server.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="${REPO_ROOT}/apps/web"
IMAGE="ai-trader-web:latest"
OUT_DIR="${REPO_ROOT}/dist"
OUT_FILE="${OUT_DIR}/ai-trader-web.tar.gz"
PLATFORM="linux/amd64"

mkdir -p "${OUT_DIR}"

echo "→ building ${IMAGE} for ${PLATFORM} from ${CONTEXT}"
docker buildx build \
  --platform "${PLATFORM}" \
  --tag "${IMAGE}" \
  --load \
  "${CONTEXT}"

echo "→ saving image to ${OUT_FILE}"
docker save "${IMAGE}" | gzip > "${OUT_FILE}"

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
#    scp dist/ai-trader-web.tar.gz user@server:~/
#
#    # or sftp:
#    sftp user@server
#    > put dist/ai-trader-web.tar.gz
#    > bye
#
#    # or stream straight in (no temp file on server):
#    docker save ai-trader-web:latest | gzip | ssh -t user@server 'gunzip | sudo docker load'

# 2. On the server, load and swap the running container:
#
#    ssh user@server
#    gunzip -c ~/ai-trader-web.tar.gz | sudo docker load
#    rm ~/ai-trader-web.tar.gz
#    cd ~/ai-trader && git pull --ff-only
#    sudo docker compose up -d --no-build --force-recreate web

# 3. Verify the new image is live:
#
#    sudo docker compose exec web ls /app/.output/server/chunks/_/holdings.mjs
#    # → should print the path. If "No such file or directory", the swap didn't take.

EOF
