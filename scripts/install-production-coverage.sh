#!/usr/bin/env bash
# Install the weekly coverage check on the production host: a systemd timer
# that runs scripts/coverage_check.ts inside the web container and stores the
# result in the ops database, where /api/status reads it.
#
# Usage: DEPLOY_HOST=root@host WOOZI_COVERAGE_DAY=Sun WOOZI_COVERAGE_TIME=05:00 \
#        bash scripts/install-production-coverage.sh
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
COVERAGE_DAY="${WOOZI_COVERAGE_DAY:-Sun}"
COVERAGE_TIME="${WOOZI_COVERAGE_TIME:-05:00}"
COVERAGE_MONTHS="${WOOZI_COVERAGE_MONTHS:-12}"

ssh "$DEPLOY_HOST" "COVERAGE_DAY='$COVERAGE_DAY' COVERAGE_TIME='$COVERAGE_TIME' COVERAGE_MONTHS='$COVERAGE_MONTHS' bash -s" <<'REMOTE'
set -euo pipefail

cat > /etc/systemd/system/woozi-coverage.service <<EOF
[Unit]
Description=OpenBesluitvorming coverage check: supplier listing against export log
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
# Sources one at a time, sharing the suppliers' request budgets with the
# nightly import; a full pass over ~330 sources takes a few hours.
ExecStart=/usr/bin/docker exec woozi-openbesluitvorming-1 deno run -A scripts/coverage_check.ts --months ${COVERAGE_MONTHS}
EOF

cat > /etc/systemd/system/woozi-coverage.timer <<EOF
[Unit]
Description=Weekly OpenBesluitvorming coverage check

[Timer]
OnCalendar=${COVERAGE_DAY} *-*-* ${COVERAGE_TIME}:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now woozi-coverage.timer
systemctl list-timers woozi-coverage.timer --no-pager
REMOTE

echo "Installed woozi-coverage.timer (${COVERAGE_DAY} ${COVERAGE_TIME}, ${COVERAGE_MONTHS} months) on $DEPLOY_HOST"
