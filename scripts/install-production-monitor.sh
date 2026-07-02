#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/woozi}"
MONITOR_INTERVAL="${WOOZI_MONITOR_INTERVAL:-2min}"

rsync -azR ./scripts/monitor-production.sh "$DEPLOY_HOST:$DEPLOY_DIR/"
ssh "$DEPLOY_HOST" "chmod +x '$DEPLOY_DIR/scripts/monitor-production.sh'"

ssh "$DEPLOY_HOST" "DEPLOY_DIR='$DEPLOY_DIR' MONITOR_INTERVAL='$MONITOR_INTERVAL' bash -s" <<'REMOTE'
set -euo pipefail

cat >/etc/systemd/system/woozi-monitor.service <<EOF
[Unit]
Description=OpenBesluitvorming production performance monitor
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=-${DEPLOY_DIR}/.env
Environment=WOOZI_MONITOR_REQUIRE_LOCAL_CHECKS=1
ExecStart=${DEPLOY_DIR}/scripts/monitor-production.sh
EOF

cat >/etc/systemd/system/woozi-monitor.timer <<EOF
[Unit]
Description=Run OpenBesluitvorming production performance monitor

[Timer]
OnBootSec=2min
OnUnitActiveSec=${MONITOR_INTERVAL}
RandomizedDelaySec=15s
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now woozi-monitor.timer
systemctl list-timers woozi-monitor.timer --no-pager
REMOTE

echo "Installed woozi-monitor.timer on $DEPLOY_HOST"
