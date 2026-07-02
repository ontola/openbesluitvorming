#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/woozi}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"

# --inplace is required because Caddyfile and quickwit.yaml are bind-mounted
# as single files into their containers. Without it rsync atomic-renames into
# a new inode, leaving the in-container mount pointing at the old (stale)
# file, and a `caddy reload` then no-ops on the unchanged in-container view.
rsync -azR --inplace \
  ./Caddyfile \
  ./docker-compose.production.yml \
  ./quickwit/quickwit.yaml \
  ./scripts/monitor-production.sh \
  "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "Synced production infra files to $DEPLOY_HOST:$DEPLOY_DIR"

# Validate the Caddyfile and reload in-place. The Caddyfile is mounted as a
# read-only volume, so a reload (vs. container recreate) keeps existing TLS
# certs warm and avoids a brief 503 window during ACME challenges.
ssh "$DEPLOY_HOST" "
  set -e
  cd \"$DEPLOY_DIR\"
  docker compose -f \"$COMPOSE_FILE\" exec -T caddy caddy validate --config /etc/caddy/Caddyfile
  docker compose -f \"$COMPOSE_FILE\" exec -T caddy caddy reload --config /etc/caddy/Caddyfile
"
echo "Reloaded Caddy on $DEPLOY_HOST"
