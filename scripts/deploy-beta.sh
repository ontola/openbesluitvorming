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
  running_count="$(
    ssh "$DEPLOY_HOST" "
      set -e
      python3 - <<'PY'
import json
import urllib.request

try:
    with urllib.request.urlopen('http://127.0.0.1:8787/api/admin/summary', timeout=5) as response:
        payload = json.load(response)
except Exception:
    print('unknown')
    raise SystemExit(0)

summary = payload.get('summary') or {}
print(summary.get('runningCount', 0))
PY
    "
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
  docker compose -f \"$COMPOSE_FILE\" pull openbesluitvorming
  docker compose -f \"$COMPOSE_FILE\" up -d openbesluitvorming caddy
  docker compose -f \"$COMPOSE_FILE\" ps openbesluitvorming caddy
"

echo "Deployed image $DEPLOY_IMAGE to $DEPLOY_HOST:$DEPLOY_DIR"
