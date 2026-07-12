#!/usr/bin/env bash
set -euo pipefail

# Installs a daily systemd timer on the production host that backs up the
# SQLite state databases (ops + export log) to S3 via scripts/backup_state.ts,
# executed inside the running openbesluitvorming container (which already has
# the S3 env, the state volume, and the script baked into its image).

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
BACKUP_TIME="${WOOZI_BACKUP_TIME:-03:30}"

ssh "$DEPLOY_HOST" "BACKUP_TIME='$BACKUP_TIME' bash -s" <<'REMOTE'
set -euo pipefail

cat >/etc/systemd/system/woozi-backup.service <<EOF
[Unit]
Description=OpenBesluitvorming SQLite state backup to S3
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker exec woozi-openbesluitvorming-1 deno run -A scripts/backup_state.ts
EOF

cat >/etc/systemd/system/woozi-backup.timer <<EOF
[Unit]
Description=Daily OpenBesluitvorming state backup

[Timer]
OnCalendar=*-*-* ${BACKUP_TIME}:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now woozi-backup.timer
systemctl list-timers woozi-backup.timer --no-pager
REMOTE

echo "Installed woozi-backup.timer on $DEPLOY_HOST"
