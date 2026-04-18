#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/woozi}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME_VALUE:-woozi}"
FORCE_DEPLOY="${FORCE:-0}"
DEPLOY_TARGET_EXPLICIT="${DEPLOY_REF:-${DEPLOY_IMAGE:-}}"

derive_image_repository() {
  local remote_url owner
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  owner="$(printf '%s' "$remote_url" | sed -nE 's#.*github.com[:/]([^/]+)/.*#\1#p')"
  if [ -n "$owner" ]; then
    printf 'ghcr.io/%s/woozi-openbesluitvorming' "$owner"
    return
  fi

  printf 'ghcr.io/openstate/woozi-openbesluitvorming'
}

IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-$(derive_image_repository)}"
DEPLOY_REF="${DEPLOY_REF:-$(git rev-parse --short=7 HEAD)}"
DEPLOY_IMAGE="${DEPLOY_IMAGE:-${IMAGE_REPOSITORY}:sha-${DEPLOY_REF}}"

if [ -z "${DEPLOY_TARGET_EXPLICIT:-}" ] && (! git diff --quiet || ! git diff --cached --quiet); then
  echo "Refusing to deploy with uncommitted changes."
  echo "Commit and push first so CI can publish an image for this revision."
  exit 1
fi

if [ "$FORCE_DEPLOY" != "1" ]; then
  # Port 8787 is exposed on the docker network only, so we probe the admin
  # endpoint from inside the openbesluitvorming container instead of the host.
  running_count="$(
    ssh "$DEPLOY_HOST" 'docker exec woozi-openbesluitvorming-1 deno eval "try { const r = await fetch(\"http://127.0.0.1:8787/api/admin/summary\", { signal: AbortSignal.timeout(5000) }); const p = await r.json(); console.log((p.summary ?? {}).runningCount ?? 0); } catch { console.log(\"unknown\"); }" 2>/dev/null || echo unknown'
  )"

  case "$running_count" in
    unknown)
      echo "Could not determine deploy readiness from the running server."
      echo "Use FORCE=1 pnpm run deploy:beta if you really want to deploy anyway."
      exit 1
      ;;
    ''|*[!0-9]*)
      echo "Unexpected deploy readiness response: $running_count"
      echo "Use FORCE=1 pnpm run deploy:beta if you really want to deploy anyway."
      exit 1
      ;;
  esac

  if [ "$running_count" -gt 0 ]; then
    echo "Refusing to deploy: $running_count import(s) are still running on the server."
    echo "Wait for imports to finish, or use FORCE=1 pnpm run deploy:beta to override."
    exit 1
  fi
fi

ssh "$DEPLOY_HOST" "
  set -e
  cd \"$DEPLOY_DIR\"
  export OPENBESLUITVORMING_IMAGE=\"$DEPLOY_IMAGE\"
  export COMPOSE_PROJECT_NAME=\"$COMPOSE_PROJECT_NAME_VALUE\"
  docker compose -f \"$COMPOSE_FILE\" pull openbesluitvorming worker
  docker compose -f \"$COMPOSE_FILE\" up -d openbesluitvorming worker caddy
  docker compose -f \"$COMPOSE_FILE\" ps openbesluitvorming worker caddy
"

echo "Deployed image $DEPLOY_IMAGE to $DEPLOY_HOST:$DEPLOY_DIR"
