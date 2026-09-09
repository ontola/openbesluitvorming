#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: pdf_render_page.sh <page_number> [dpi]" >&2
  exit 2
fi

PAGE_NUMBER="$1"
case "$PAGE_NUMBER" in
  ''|*[!0-9]*)
    echo "invalid page number: $PAGE_NUMBER" >&2
    exit 2
    ;;
esac

# 96 dpi is a laptop screen; a phone shows the same page at two to three
# device pixels per CSS pixel and turns that into mush when zoomed (#286).
DPI="${2:-96}"
case "$DPI" in
  ''|*[!0-9]*)
    echo "invalid dpi: $DPI" >&2
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

mutool draw -q -F png -r "$DPI" -o - "$PDF_FILE" "$PAGE_NUMBER" | ffmpeg -loglevel quiet -i pipe:0 -q:v 5 -f mjpeg pipe:1
