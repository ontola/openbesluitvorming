# Persistent overrides for `infra/variables.tf`. Committed so the next
# `tofu apply` doesn't silently drop back to the variable default.

# Steady-state extraction pool: nightly scheduler + occasional manual runs
# fit comfortably in 2 workers (observed load_1m ≈ 0 across the prior fleet
# of 10). Scale up temporarily for a big reingest:
#   tofu apply -var=extraction_server_count=8
extraction_server_count = 2
