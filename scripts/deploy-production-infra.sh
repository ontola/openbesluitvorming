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
  ./otel/collector.yaml \
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

# The collector reads its config once, at startup, and the file is bind-mounted
# read-only -- so syncing collector.yaml on its own changes nothing until the
# container restarts. It was synced here for a while without that restart, which
# is the quietest possible way for a config change to not happen.
#
# Validated first, in a throwaway container with the same mounts: the collector
# exits on a config error, and `restart: unless-stopped` then turns that into a
# crashloop with no telemetry at all.
ssh "$DEPLOY_HOST" "
  set -e
  cd \"$DEPLOY_DIR\"
  docker compose -f \"$COMPOSE_FILE\" run --rm --no-deps otel-collector validate --config=/etc/otelcol/config.yaml
  docker compose -f \"$COMPOSE_FILE\" restart otel-collector
"
echo "Restarted the OTel collector on $DEPLOY_HOST"
