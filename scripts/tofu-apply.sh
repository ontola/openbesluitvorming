#!/usr/bin/env bash
set -euo pipefail

# Wrapper around `tofu apply` (or any tofu subcommand) that pulls the S3 and
# SigNoz credentials straight from production's /opt/woozi/.env instead of
# requiring a second copy stored locally. /opt/woozi/.env stays the single
# source of truth; nothing sensitive is written to disk here or echoed.
#
# HCLOUD_TOKEN is NOT fetched this way -- it's an infra-provisioning secret,
# not an app secret, and was never stored on the production server. Keep
# exporting it yourself (shell profile / password manager) as before.
#
#   scripts/tofu-apply.sh                              # plan+apply with current tfvars
#   scripts/tofu-apply.sh -var=extraction_server_count=8

DEPLOY_HOST="${DEPLOY_HOST:-root@91.98.32.151}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/woozi}"

if [ -z "${HCLOUD_TOKEN:-}" ]; then
  echo "HCLOUD_TOKEN is not set in your environment. Export it first (this one is not on the server)." >&2
  exit 1
fi

fetch_env_value() {
  local key="$1"
  ssh "$DEPLOY_HOST" "grep -E '^${key}=' '$DEPLOY_DIR/.env' | head -n1 | cut -d= -f2-"
}

echo "Fetching S3/SigNoz credentials from ${DEPLOY_HOST}:${DEPLOY_DIR}/.env ..." >&2

export TF_VAR_s3_storage_endpoint
export TF_VAR_s3_storage_bucket_name
export TF_VAR_s3_access_key
export TF_VAR_s3_secret_key
export TF_VAR_signoz_ingestion_key

TF_VAR_s3_storage_endpoint="$(fetch_env_value S3_STORAGE_ENDPOINT)"
TF_VAR_s3_storage_bucket_name="$(fetch_env_value S3_STORAGE_BUCKET_NAME)"
TF_VAR_s3_access_key="$(fetch_env_value S3_ACCESS_KEY)"
TF_VAR_s3_secret_key="$(fetch_env_value S3_SECRET_KEY)"
TF_VAR_signoz_ingestion_key="$(fetch_env_value SIGNOZ_INGESTION_KEY)"

for name in TF_VAR_s3_storage_endpoint TF_VAR_s3_storage_bucket_name TF_VAR_s3_access_key TF_VAR_s3_secret_key; do
  if [ -z "${!name}" ]; then
    echo "Could not read ${name#TF_VAR_} from ${DEPLOY_DIR}/.env on ${DEPLOY_HOST}." >&2
    exit 1
  fi
done

# The script already insists on HCLOUD_TOKEN being set, but never handed it to
# tofu, so every run stopped to prompt for var.hcloud_token interactively.
export TF_VAR_hcloud_token="$HCLOUD_TOKEN"

# The S3 state backend authenticates separately from the TF_VAR_* above. Its
# credentials were baked in at `tofu init -backend-config=...` time, so once the
# S3 keys were rotated every run died with "InvalidAccessKeyId" (403) before
# reaching the plan. Handing the current keys to the backend through the
# standard AWS variables keeps them in this process only -- re-running init with
# -backend-config would instead persist them into infra/.terraform, which is
# exactly the leak this wrapper exists to avoid.
export AWS_ACCESS_KEY_ID="$TF_VAR_s3_access_key"
export AWS_SECRET_ACCESS_KEY="$TF_VAR_s3_secret_key"

cd "$(dirname "$0")/../infra"

# The header has always advertised "or any tofu subcommand", but this only ever
# ran apply -- so there was no way to read a plan with the credentials wired up,
# and the only route to seeing what an apply would do was to run it. Treat a
# leading bare word as the subcommand; `-var=...` style args still default to
# apply, so existing invocations are unchanged.
subcommand="apply"
case "${1:-}" in
  "" | -*) ;;
  *)
    subcommand="$1"
    shift
    ;;
esac

tofu "$subcommand" "$@"
