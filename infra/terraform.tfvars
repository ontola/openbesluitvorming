# Persistent overrides for `infra/variables.tf`. Committed so the next
# `tofu apply` doesn't silently drop back to the variable default.

# Steady-state extraction pool: nightly scheduler + occasional manual runs
# fit comfortably in 2 workers (observed load_1m ≈ 0 across the prior fleet
# of 10). Scale up temporarily for a big reingest:
#   tofu apply -var=extraction_server_count=8
#
# Since July 2026 the extraction service needs S3 credentials at provision
# time (it uploads extracted markdown itself; without credentials every
# /extract fails). Pass them as TF_VAR_* env vars — same values as the S3_*
# entries in /opt/woozi/.env on the ingest server. Never put them in this
# file:
#   export TF_VAR_s3_storage_endpoint=... TF_VAR_s3_storage_bucket_name=... \
#          TF_VAR_s3_access_key=... TF_VAR_s3_secret_key=...
#   tofu apply -var=extraction_server_count=8
#
# Also pass TF_VAR_signoz_ingestion_key (value: SIGNOZ_INGESTION_KEY in
# /opt/woozi/.env) so new hosts report host metrics to SigNoz; without it the
# node collector is skipped and the host is invisible in the Infrastructure
# view. Existing hosts got the collector installed by hand (July 2026).
# After scaling, update WOOZI_EXTRACTION_SERVICE_URL in /opt/woozi/.env with
# the new worker IPs (tofu output) and recreate the worker containers.
# Temporarily at 8 for the July 2026 full-history backfill (extraction hosts
# were CPU-saturated at 2). Scale back to 2 when the backfill queue drains.
extraction_server_count = 8

# 4 uvicorn workers on 2-vCPU hosts: the service downloads the PDF (I/O-bound)
# before the CPU-bound extraction, so 2x oversubscription overlaps downloads
# with extraction.
extraction_uvicorn_workers = 4
