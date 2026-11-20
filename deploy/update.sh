#!/usr/bin/env bash
# Zero-touch update: pull the latest code, rebuild, restart, wait until healthy.
#   bash /opt/hotel-offer-orchestrator/deploy/update.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${BRANCH:-$(git -C "${APP_DIR}" rev-parse --abbrev-ref HEAD)}"
cd "${APP_DIR}"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
if ! docker info >/dev/null 2>&1; then COMPOSE=(sudo "${COMPOSE[@]}"); fi

before="$(git rev-parse --short HEAD)"
git fetch --quiet origin "${BRANCH}"
git pull --ff-only --quiet origin "${BRANCH}"
after="$(git rev-parse --short HEAD)"
echo "code: ${before} -> ${after}"

# Rebuild the app image and recreate only what changed; Temporal/Postgres/Redis data volumes are kept.
"${COMPOSE[@]}" up -d --build --remove-orphans --wait --wait-timeout 600
"${COMPOSE[@]}" ps
docker image prune -f >/dev/null 2>&1 || sudo docker image prune -f >/dev/null 2>&1 || true

domain="$(grep -E '^PUBLIC_DOMAIN=' .env | cut -d= -f2-)"
if curl -fsS "https://${domain}/health/live" >/dev/null; then
  echo "healthy: https://${domain}"
else
  echo "warning: https://${domain}/health/live did not answer yet; check: ${COMPOSE[*]} logs --tail 100" >&2
fi
