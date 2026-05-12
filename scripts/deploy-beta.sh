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
# How many worker replicas to run. Each is a Deno process pinned to one vCPU,
# so scale to match available cores. Workers share the SQLite queue and claim
# runs atomically.
WORKER_REPLICAS="${WORKER_REPLICAS:-3}"

if [ -z "${DEPLOY_TARGET_EXPLICIT:-}" ] && (! git diff --quiet || ! git diff --cached --quiet); then
  echo "Refusing to deploy with uncommitted changes."
  echo "Commit and push first so CI can publish an image for this revision."
  exit 1
fi

# We deliberately do not block on imports-in-progress: the daily scheduler
# enqueues ~290 runs every night and there are usually a handful still in
# flight for most of the working day. Reconcile-on-startup marks any
# `running` rows as failed when the worker restarts, and tomorrow's tick
# picks them back up; cache hits make the rerun cheap. If you genuinely
# need to wait for idle, watch /api/admin/summary manually before deploying.

ssh "$DEPLOY_HOST" "
  set -e
  cd \"$DEPLOY_DIR\"
  export OPENBESLUITVORMING_IMAGE=\"$DEPLOY_IMAGE\"
  export COMPOSE_PROJECT_NAME=\"$COMPOSE_PROJECT_NAME_VALUE\"
  docker compose -f \"$COMPOSE_FILE\" pull openbesluitvorming worker
  docker compose -f \"$COMPOSE_FILE\" up -d --scale worker=${WORKER_REPLICAS} openbesluitvorming worker caddy
  docker compose -f \"$COMPOSE_FILE\" ps openbesluitvorming worker caddy
"

echo "Deployed image $DEPLOY_IMAGE to $DEPLOY_HOST:$DEPLOY_DIR"
