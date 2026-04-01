#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_GIT_DIR="${DEPLOY_GIT_DIR:-/opt/woozi.git}"
DEPLOY_WORK_TREE="${DEPLOY_WORK_TREE:-/opt/woozi-git}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_REF="${DEPLOY_REF:-HEAD}"
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME_VALUE:-woozi}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy with uncommitted changes."
  echo "Commit or stash local work first, then rerun."
  exit 1
fi

ssh "$DEPLOY_HOST" "
  set -e
  mkdir -p \"$(dirname "$DEPLOY_GIT_DIR")\"
  if [ ! -d \"$DEPLOY_GIT_DIR\" ]; then
    git init --bare \"$DEPLOY_GIT_DIR\"
  fi
"

git push "$DEPLOY_HOST:$DEPLOY_GIT_DIR" "$DEPLOY_REF:refs/heads/$DEPLOY_BRANCH"

ssh "$DEPLOY_HOST" "
  set -e
  mkdir -p \"$DEPLOY_WORK_TREE\"
  git --git-dir=\"$DEPLOY_GIT_DIR\" --work-tree=\"$DEPLOY_WORK_TREE\" checkout -f \"$DEPLOY_BRANCH\"
  git --git-dir=\"$DEPLOY_GIT_DIR\" --work-tree=\"$DEPLOY_WORK_TREE\" clean -fdx
  if [ ! -f \"$DEPLOY_WORK_TREE/.env\" ] && [ -f /opt/woozi/.env ]; then
    cp /opt/woozi/.env \"$DEPLOY_WORK_TREE/.env\"
  fi
  cd \"$DEPLOY_WORK_TREE\"
  COMPOSE_PROJECT_NAME=\"$COMPOSE_PROJECT_NAME_VALUE\" docker compose -f docker-compose.production.yml up -d --build
"

echo "Deployed $DEPLOY_REF to $DEPLOY_HOST:$DEPLOY_WORK_TREE"
