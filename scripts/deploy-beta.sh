#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/woozi}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME_VALUE:-woozi}"
DEPLOY_TARGET_EXPLICIT="${DEPLOY_REF:-${DEPLOY_IMAGE:-}}"

derive_image_repository() {
  local remote_url owner
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  owner="$(printf '%s' "$remote_url" | sed -nE 's#.*github.com[:/]([^/]+)/.*#\1#p')"
  if [ -n "$owner" ]; then
    printf 'ghcr.io/%s/openbesluitvorming' "$owner"
    return
  fi

  printf 'ghcr.io/ontola/openbesluitvorming'
}

IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-$(derive_image_repository)}"
DEPLOY_REF="${DEPLOY_REF:-$(git rev-parse --short=7 HEAD)}"
DEPLOY_IMAGE="${DEPLOY_IMAGE:-${IMAGE_REPOSITORY}:sha-${DEPLOY_REF}}"
# Worker scale and concurrency are server state, not deploy parameters: a
# deploy must never silently rescale the import pipeline. (The old defaults —
# 0 replicas, concurrency 1 — disabled or crippled imports after every deploy;
# the queue grew unattended for 11 days in July 2026 before anyone noticed.)
# Precedence:
#   1. caller env (WORKER_REPLICAS=... pnpm run deploy:beta)
#   2. WOOZI_WORKER_REPLICAS in /opt/woozi/.env on the server
#   3. default: 1 replica
# INGEST_CONCURRENCY / WOOZI_DOCUMENT_CONCURRENCY are only forwarded when the
# caller sets them; otherwise the server's .env / compose defaults apply.
if [ -z "${WORKER_REPLICAS:-}" ]; then
  WORKER_REPLICAS="$(ssh "$DEPLOY_HOST" "grep -E '^WOOZI_WORKER_REPLICAS=' '$DEPLOY_DIR/.env' 2>/dev/null | head -n1 | cut -d= -f2" || true)"
fi
WORKER_REPLICAS="${WORKER_REPLICAS:-1}"

CONCURRENCY_EXPORTS=""
if [ -n "${INGEST_CONCURRENCY:-}" ]; then
  CONCURRENCY_EXPORTS="export INGEST_CONCURRENCY=\"$INGEST_CONCURRENCY\";"
fi
if [ -n "${WOOZI_DOCUMENT_CONCURRENCY:-}" ]; then
  CONCURRENCY_EXPORTS="$CONCURRENCY_EXPORTS export WOOZI_DOCUMENT_CONCURRENCY=\"$WOOZI_DOCUMENT_CONCURRENCY\";"
fi

if [ -z "${DEPLOY_TARGET_EXPLICIT:-}" ] && (! git diff --quiet || ! git diff --cached --quiet); then
  echo "Refusing to deploy with uncommitted changes."
  echo "Commit and push first so CI can publish an image for this revision."
  exit 1
fi

# We deliberately do not block on imports-in-progress: the daily scheduler
# enqueues ~290 runs every night and there are usually a handful still in
# flight for most of the working day. Reconcile-on-startup requeues any
# `running` rows interrupted by the restart (capped at two requeues per run),
# and cache hits make the rerun cheap. If you genuinely need to wait for
# idle, watch /api/admin/summary manually before deploying.

# Sync runtime config alongside the image. $DEPLOY_DIR is a plain copy, not a
# checkout: without this step, compose/Caddyfile changes in git silently never
# reach production (bitten July 2026: a Caddy security fix and a new compose
# env var were "deployed" but inactive until synced by hand). The infra script
# rsyncs Caddyfile/compose/quickwit.yaml/monitor and reloads Caddy in place.
DEPLOY_HOST="$DEPLOY_HOST" DEPLOY_DIR="$DEPLOY_DIR" COMPOSE_FILE="$COMPOSE_FILE" \
  bash "$(dirname "$0")/deploy-beta-infra.sh"

ssh "$DEPLOY_HOST" "
  set -e
  cd \"$DEPLOY_DIR\"
  export OPENBESLUITVORMING_IMAGE=\"$DEPLOY_IMAGE\"
  export COMPOSE_PROJECT_NAME=\"$COMPOSE_PROJECT_NAME_VALUE\"
  $CONCURRENCY_EXPORTS
  docker compose -f \"$COMPOSE_FILE\" pull openbesluitvorming worker
  docker compose -f \"$COMPOSE_FILE\" up -d --scale worker=${WORKER_REPLICAS} openbesluitvorming worker caddy otel-collector
  docker compose -f \"$COMPOSE_FILE\" ps openbesluitvorming worker caddy otel-collector

  # Every deploy leaves a ~2GB sha-tagged image behind; they filled 43GB and
  # tripped the disk alert (July 2026). 72h retention re-tripped it within a
  # day: an active dev day produces ~7 deploys (~14GB) and three such days
  # stack. Keep 24h for quick rollback (all images remain re-pullable from
  # GHCR), drop the rest.
  docker image prune -af --filter 'until=24h' >/dev/null || true
"

echo "Deployed image $DEPLOY_IMAGE to $DEPLOY_HOST:$DEPLOY_DIR"
