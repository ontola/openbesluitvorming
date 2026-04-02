#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/woozi}"

rsync -azR \
  ./Caddyfile \
  ./docker-compose.production.yml \
  ./quickwit/quickwit.yaml \
  "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "Synced production infra files to $DEPLOY_HOST:$DEPLOY_DIR"
