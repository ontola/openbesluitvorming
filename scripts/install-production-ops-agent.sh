#!/usr/bin/env bash
set -euo pipefail

# Installs the ops host agent (scripts/ops_host_agent.py) as a systemd timer on
# the production host. It runs every 15 seconds and handles the two ops
# endpoint actions that need Docker: restart_service and service_logs, for an
# allow-listed set of compose services. It also records each service's state
# for GET /api/ops/health. See deployment.md, "Ops Endpoint".
#
# The script itself is kept in sync by every deploy (deploy-production-infra.sh
# rsyncs it); this only has to run once, and again if the unit changes.

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/woozi}"

rsync -azR ./scripts/ops_host_agent.py "$DEPLOY_HOST:$DEPLOY_DIR/"
ssh "$DEPLOY_HOST" "chmod +x '$DEPLOY_DIR/scripts/ops_host_agent.py'"

ssh "$DEPLOY_HOST" "DEPLOY_DIR='$DEPLOY_DIR' bash -s" <<'REMOTE'
set -euo pipefail

cat >/etc/systemd/system/woozi-ops-agent.service <<EOF
[Unit]
Description=OpenBesluitvorming ops host agent (restarts and logs for /api/ops)
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=${DEPLOY_DIR}
Environment=WOOZI_COMPOSE_DIR=${DEPLOY_DIR}
# A restart waits for the container's stop grace period.
TimeoutStartSec=600
ExecStart=/usr/bin/python3 ${DEPLOY_DIR}/scripts/ops_host_agent.py
EOF

cat >/etc/systemd/system/woozi-ops-agent.timer <<EOF
[Unit]
Description=Run the OpenBesluitvorming ops host agent

[Timer]
OnBootSec=1min
OnUnitActiveSec=15s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now woozi-ops-agent.timer
systemctl list-timers woozi-ops-agent.timer --no-pager
REMOTE

echo "Installed woozi-ops-agent.timer on $DEPLOY_HOST"
