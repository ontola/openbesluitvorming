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

cd "$(dirname "$0")/../infra"
tofu apply "$@"
