#!/usr/bin/env bash
set -euo pipefail

# Installs a daily systemd timer on the production host that runs the source
# revalidation sweep (scripts/revalidate_documents.ts) for each calibrated
# supplier, executed inside the running openbesluitvorming container (which
# already has Quickwit and the ops SQLite state volume).
#
# The sweep only reports confirmed-gone documents (ops SQLite,
# document_revalidation table) -- it never deletes anything. Review its
# output (journalctl -u woozi-revalidate) and delete manually via
# scripts/delete_document.ts if legitimate.

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
REVALIDATE_TIME="${WOOZI_REVALIDATE_TIME:-02:00}"
REVALIDATE_LIMIT="${WOOZI_REVALIDATE_LIMIT:-500}"

ssh "$DEPLOY_HOST" "REVALIDATE_TIME='$REVALIDATE_TIME' REVALIDATE_LIMIT='$REVALIDATE_LIMIT' bash -s" <<'REMOTE'
set -euo pipefail

cat >/etc/systemd/system/woozi-revalidate.service <<EOF
[Unit]
Description=OpenBesluitvorming source revalidation sweep (ibabs + notubiz)
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker exec woozi-openbesluitvorming-1 deno run -A scripts/revalidate_documents.ts --supplier ibabs --limit ${REVALIDATE_LIMIT}
ExecStart=/usr/bin/docker exec woozi-openbesluitvorming-1 deno run -A scripts/revalidate_documents.ts --supplier notubiz --limit ${REVALIDATE_LIMIT}
EOF

cat >/etc/systemd/system/woozi-revalidate.timer <<EOF
[Unit]
Description=Daily OpenBesluitvorming source revalidation sweep

[Timer]
OnCalendar=*-*-* ${REVALIDATE_TIME}:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now woozi-revalidate.timer
systemctl list-timers woozi-revalidate.timer --no-pager
REMOTE

echo "Installed woozi-revalidate.timer on $DEPLOY_HOST"
