#!/usr/bin/env bash
# Install the weekly coverage check on the production host: a systemd timer
# that runs scripts/coverage_check.ts inside the web container and stores the
# result in the ops database, where /api/status reads it.
#
# Usage: DEPLOY_HOST=root@host WOOZI_COVERAGE_DAY=Sun WOOZI_COVERAGE_TIME=08:00 \
#        bash scripts/install-production-coverage.sh
#
# The check shares the iBabs per-address budget with the workers, paced at
# one worker's share, so it takes hours and must not overlap the nightly
# imports (00:00 until about 08:00): the first run, at 05:00, pushed the
# address over budget within minutes and iBabs blocked imports and check
# alike. Re-run this script after changing the time; a deploy does not.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
COVERAGE_DAY="${WOOZI_COVERAGE_DAY:-Sun}"
COVERAGE_TIME="${WOOZI_COVERAGE_TIME:-08:00}"
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
WorkingDirectory=/opt/woozi
# Sources one at a time, sharing the suppliers' request budgets with the
# nightly import; a full pass over ~330 sources takes a few hours.
#
# In a container of its own, not exec'd into the web container: every deploy
# recreates that container and killed the run with it, five times in one
# week (2026-09-08..10), and its deno process outlived the systemd unit as
# an orphan. compose run gives it the same image, environment, volume and
# network, and a life of its own.
ExecStart=/usr/bin/docker compose -f docker-compose.production.yml run --rm --no-deps -T openbesluitvorming deno run -A scripts/coverage_check.ts --months ${COVERAGE_MONTHS}
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
