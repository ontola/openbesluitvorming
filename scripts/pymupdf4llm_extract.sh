#!/bin/sh
set -eu
TARGET="$0"
while [ -L "$TARGET" ]; do
  LINK=$(readlink "$TARGET")
  case "$LINK" in
    /*) TARGET="$LINK" ;;
    *) TARGET="$(dirname -- "$TARGET")/$LINK" ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$TARGET")" && pwd)
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$SCRIPT_DIR/pymupdf4llm_extract.py" "$@"
fi
exec "$SCRIPT_DIR/../.venv-pymupdf/bin/python" "$SCRIPT_DIR/pymupdf4llm_extract.py" "$@"
