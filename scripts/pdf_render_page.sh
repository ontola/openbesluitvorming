#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: pdf_render_page.sh <page_number>" >&2
  exit 2
fi

PAGE_NUMBER="$1"
case "$PAGE_NUMBER" in
  ''|*[!0-9]*)
    echo "invalid page number: $PAGE_NUMBER" >&2
    exit 2
    ;;
esac

TMP_DIR="${TMPDIR:-/tmp}"
PDF_FILE="$(mktemp "$TMP_DIR/woozi-pdf-render-XXXXXX.pdf")"
cleanup() {
  rm -f "$PDF_FILE"
}
trap cleanup EXIT INT TERM

cat > "$PDF_FILE"

PAGE_COUNT="$(mutool show "$PDF_FILE" trailer/Root/Pages/Count 2>/dev/null | tr -d '\r\n[:space:]')"
case "$PAGE_COUNT" in
  ''|*[!0-9]*)
    echo "failed to determine page count" >&2
    exit 3
    ;;
esac

echo "$PAGE_COUNT" >&2

if [ "$PAGE_NUMBER" -lt 1 ] || [ "$PAGE_NUMBER" -gt "$PAGE_COUNT" ]; then
  exit 1
fi

exec mutool draw -q -F png -r 144 -o - "$PDF_FILE" "$PAGE_NUMBER"
