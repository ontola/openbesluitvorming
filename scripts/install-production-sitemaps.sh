#!/usr/bin/env bash
# Install the daily sitemap generation on the production host: a systemd timer
# that runs scripts/generate_sitemaps.ts in a container of its own and writes
# sitemap.xml and the per-organization sitemaps to object storage, where the
# web container serves them (#206).
#
# Usage: DEPLOY_HOST=root@host WOOZI_SITEMAPS_TIME=09:30 WOOZI_SITEMAPS_MONTHS=12 \
#        bash scripts/install-production-sitemaps.sh
#
# The job reads the export log, which every import worker writes, so it runs
# after the nightly imports (00:00 until about 08:00). Reading is safe next to
# writers (the log is in WAL mode) but it parses every live meeting and document
# record of every source, so expect it to take a while; the first run says how
# long. Re-run this script after changing the time or the window; a deploy
# does not.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
SITEMAPS_TIME="${WOOZI_SITEMAPS_TIME:-09:30}"
SITEMAPS_MONTHS="${WOOZI_SITEMAPS_MONTHS:-12}"

ssh "$DEPLOY_HOST" "SITEMAPS_TIME='$SITEMAPS_TIME' SITEMAPS_MONTHS='$SITEMAPS_MONTHS' bash -s" <<'REMOTE'
set -euo pipefail

cat > /etc/systemd/system/woozi-sitemaps.service <<EOF
[Unit]
Description=OpenBesluitvorming sitemaps: export log to sitemap.xml in object storage
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/woozi
# A container of its own, like the coverage check: a deploy recreates the web
# container and would kill a run exec'd into it.
ExecStart=/usr/bin/docker compose -f docker-compose.production.yml run --rm --no-deps -T openbesluitvorming deno run -A scripts/generate_sitemaps.ts --months ${SITEMAPS_MONTHS}
EOF

cat > /etc/systemd/system/woozi-sitemaps.timer <<EOF
[Unit]
Description=Daily OpenBesluitvorming sitemaps

[Timer]
OnCalendar=*-*-* ${SITEMAPS_TIME}:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now woozi-sitemaps.timer
systemctl list-timers woozi-sitemaps.timer --no-pager
REMOTE

echo "Installed woozi-sitemaps.timer (daily ${SITEMAPS_TIME}, ${SITEMAPS_MONTHS} months) on $DEPLOY_HOST"
