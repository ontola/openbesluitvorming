#!/bin/sh
set -eu

PATH_PREFIX="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"
export PATH="$PATH_PREFIX:$PATH"

if command -v docker >/dev/null 2>&1; then
  DOCKER_BIN="$(command -v docker)"
elif [ -x /usr/local/bin/docker ]; then
  DOCKER_BIN=/usr/local/bin/docker
elif [ -x /opt/homebrew/bin/docker ]; then
  DOCKER_BIN=/opt/homebrew/bin/docker
else
  echo "docker not found in PATH or common install locations" >&2
  exit 127
fi

exec "$DOCKER_BIN" compose "$@"
