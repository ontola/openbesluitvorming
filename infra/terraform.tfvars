# Persistent overrides for `infra/variables.tf`. Committed so the next
# `tofu apply` doesn't silently drop back to the variable default.

# Steady-state extraction pool: nightly scheduler + occasional manual runs
# fit comfortably in 2 workers (observed load_1m ≈ 0 across the prior fleet
# of 10). Scale up temporarily for a big reingest:
#   scripts/tofu-apply.sh -var=extraction_server_count=8
#
# The extraction service needs S3 credentials at provision time (it uploads
# extracted markdown itself; without credentials every /extract fails), plus
# TF_VAR_signoz_ingestion_key so new hosts report host metrics to SigNoz
# (skipped, and the host invisible in the Infrastructure view, if empty).
# Use `scripts/tofu-apply.sh` instead of `tofu apply` directly -- it pulls
# S3_*/SIGNOZ_INGESTION_KEY straight from /opt/woozi/.env over SSH and
# exports them as TF_VAR_* for the run, so there's never a second copy of
# these credentials sitting locally. (One such copy leaked into
# infra/.terraform/terraform.tfstate in April 2026 -- since rotated -- which
# is exactly what this wrapper avoids repeating.) HCLOUD_TOKEN still needs
# to be exported yourself; it's an infra-provisioning credential, never
# stored on the app server.
# After scaling, update WOOZI_EXTRACTION_SERVICE_URL in /opt/woozi/.env with
# the new worker IPs (tofu output) and recreate the worker containers.
# Back to the steady-state 2 on 2026-08-02: the July 2026 full-history backfill
# finished (queue drained, 5.13M unique documents, 97.3% of the legacy corpus),
# so the temporary fleet of 8 is no longer earning its EUR188.66/mo -- steady
# state is EUR47.17.
extraction_server_count = 2

# 4 uvicorn workers on 2-vCPU hosts: the service downloads the PDF (I/O-bound)
# before the CPU-bound extraction, so 2x oversubscription overlaps downloads
# with extraction.
extraction_uvicorn_workers = 4
