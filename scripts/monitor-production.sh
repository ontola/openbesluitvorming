#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${WOOZI_MONITOR_BASE_URL:-https://openbesluitvorming.nl}"
SEARCH_TIMEOUT_SECONDS="${WOOZI_MONITOR_SEARCH_TIMEOUT_SECONDS:-15}"
SEARCH_WARN_MS="${WOOZI_MONITOR_SEARCH_WARN_MS:-2000}"
SEARCH_CRITICAL_MS="${WOOZI_MONITOR_SEARCH_CRITICAL_MS:-8000}"
QUICKWIT_WARN_MS="${WOOZI_MONITOR_QUICKWIT_WARN_MS:-1500}"
DISK_WARN_PERCENT="${WOOZI_MONITOR_DISK_WARN_PERCENT:-80}"
DISK_CRITICAL_PERCENT="${WOOZI_MONITOR_DISK_CRITICAL_PERCENT:-90}"
# Percentage of the currently-published split count, below which the
# searcher split cache is considered cold (see check_containers). Was a
# fixed absolute split count until the split-cache janitor made "healthy"
# track the live count instead of a historical constant.
QUICKWIT_MIN_CACHE_SPLITS="${WOOZI_MONITOR_QUICKWIT_MIN_CACHE_SPLITS:-70}"
CONTAINER_RESTART_WARN="${WOOZI_MONITOR_CONTAINER_RESTART_WARN:-0}"
STATE_DIR="${WOOZI_MONITOR_STATE_DIR:-/tmp/woozi-monitor-alerts}"
ALERT_COOLDOWN_SECONDS="${WOOZI_MONITOR_ALERT_COOLDOWN_SECONDS:-900}"
OPS_DB="${WOOZI_MONITOR_OPS_DB:-/var/lib/docker/volumes/woozi_woozi-state/_data/woozi-ops.sqlite3}"
IMPORT_STALL_HOURS="${WOOZI_MONITOR_IMPORT_STALL_HOURS:-26}"
QUEUE_STUCK_MINUTES="${WOOZI_MONITOR_QUEUE_STUCK_MINUTES:-30}"
# New extract/download failures per monitor interval (default: per 2 min).
EXTRACT_FAIL_WARN="${WOOZI_MONITOR_EXTRACT_FAIL_WARN:-50}"
EXTRACT_FAIL_CRITICAL="${WOOZI_MONITOR_EXTRACT_FAIL_CRITICAL:-300}"
# The import worker is expected to run at all times since deploy-beta.sh
# defaults WORKER_REPLICAS to 1. Set to 0 during an intentional scale-down.
EXPECT_WORKER="${WOOZI_MONITOR_EXPECT_WORKER:-1}"
# Alert when the last successful state backup is older than this; 0 disables.
BACKUP_STALE_HOURS="${WOOZI_MONITOR_BACKUP_STALE_HOURS:-50}"
# Self-heal for the worker fd/socket leak (July 2026): Deno workers slowly
# accumulate closed-but-unreleased sockets under heavy fetch churn; past
# ~13k fds, outgoing connections start failing (S3 writes with
# AggregateError). Restart the workers well before that point — reconcile
# requeues any interrupted runs. 0 disables.
WORKER_FD_MAX="${WOOZI_MONITOR_WORKER_FD_MAX:-10000}"
# Remind (daily) to scale the extraction fleet back down once the import
# queue has drained and more hosts than the steady-state baseline are
# configured. See infra/terraform.tfvars for the scale-down procedure.
SCALE_DOWN_BASELINE_HOSTS="${WOOZI_MONITOR_SCALE_DOWN_BASELINE_HOSTS:-2}"
# Self-heal for searcher-split-cache pollution (July 2026): the index was
# created with commit_timeout_secs: 1, so heavy ingest constantly produces
# tiny splits that get merged away within days — but their cache files are
# never reclaimed. The dead files accumulate faster than the ~40G cache
# evicts them, pushing out the live splits, so cold searches keep re-fetching
# from S3 (5-50s instead of <1s). Self-heals by wiping the cache and
# restarting quickwit once the cache holds more files than a small multiple
# of the actually-published splits. 0 disables.
QUICKWIT_SPLIT_CACHE_POLLUTION_RATIO="${WOOZI_MONITOR_QUICKWIT_SPLIT_CACHE_POLLUTION_RATIO:-3}"
# Below this file count, don't even compute a ratio — avoids noise right
# after a wipe or on a freshly (re)built index with few real splits.
QUICKWIT_SPLIT_CACHE_POLLUTION_MIN_FILES="${WOOZI_MONITOR_QUICKWIT_SPLIT_CACHE_POLLUTION_MIN_FILES:-150}"
QUICKWIT_INDEX_ID="${WOOZI_MONITOR_QUICKWIT_INDEX_ID:-woozi-events-prod}"
QUICKWIT_INDEX_ROOT_PREFIX="${WOOZI_MONITOR_QUICKWIT_INDEX_ROOT_PREFIX:-indexes-prod}"
# Floor between two cache purges regardless of how often the ratio trips —
# the purge itself resets the ratio to ~1x, so this only guards against a
# flapping/misreading metastore causing a restart loop.
QUICKWIT_SPLIT_CACHE_HEAL_COOLDOWN_SECONDS="${WOOZI_MONITOR_QUICKWIT_SPLIT_CACHE_HEAL_COOLDOWN_SECONDS:-1800}"
SCALE_DOWN_QUEUE_THRESHOLD="${WOOZI_MONITOR_SCALE_DOWN_QUEUE_THRESHOLD:-10}"
SCALE_DOWN_REMIND_SECONDS="${WOOZI_MONITOR_SCALE_DOWN_REMIND_SECONDS:-86400}"
CURL_IP_VERSION="${WOOZI_MONITOR_CURL_IP_VERSION:-4}"
SEARCH_ALERT_AFTER_CONSECUTIVE="${WOOZI_MONITOR_SEARCH_ALERT_AFTER_CONSECUTIVE:-3}"

DEFAULT_TERMS=(
  woningbouw wateroverlast fietsbrug dorpshuis groenbeheer laadinfra subsidieplafond
  verkeersveiligheid openbareverlichting mantelzorgwoning klimaatadaptatie speelruimtebeleid
  parkeerhub schuldhulpverlening omgevingsvisie bedrijventerrein dijkversterking riolering
  jeugdraad sporthal bibliotheek geluidswal warmtenet zonnepark afvalscheiding waterberging
  wijkcentrum schoolroute kunstgrasveld brugrenovatie bomenkap fietsstraat marktvisie
  woonwagen natuurbeheer toegankelijkheid grondbeleid zwembad begroting jaarrekening
  inkoopbeleid veiligheidsplan dorpsplein regenwater speelplaats parkeerdruk woningcorporatie
  welstandsnota arbeidsmigranten energiearmoede leerlingenvervoer evenementenbeleid
  waterkwaliteit rekenkamer participatie gebiedsvisie verkeersplein fietspad groenstrook
  handhaving
)

ALERTS=()

alert() {
  local severity="$1"
  local key="$2"
  local title="$3"
  local details="$4"
  ALERTS+=("${severity}|${key}|${title}|${details}")
}

record_search_ok() {
  mkdir -p "$STATE_DIR"
  printf '0\n' > "$STATE_DIR/search_degraded_streak"
}

record_search_degraded() {
  local severity="$1"
  local key="$2"
  local title="$3"
  local details="$4"
  local state_file="$STATE_DIR/search_degraded_streak"
  local previous streak
  mkdir -p "$STATE_DIR"
  previous="$(cat "$state_file" 2>/dev/null || echo 0)"
  if ! [[ "$previous" =~ ^[0-9]+$ ]]; then
    previous=0
  fi
  streak=$((previous + 1))
  printf '%s\n' "$streak" > "$state_file"

  if [ "$streak" -ge "$SEARCH_ALERT_AFTER_CONSECUTIVE" ]; then
    alert "$severity" "$key" "$title" "${details} degraded_streak=${streak}"
  else
    printf '{"event":"monitor_search_degraded_pending","key":"%s","streak":%s,"alert_after":%s}\n' \
      "$key" "$streak" "$SEARCH_ALERT_AFTER_CONSECUTIVE"
  fi
}

pick_term() {
  local configured="${WOOZI_MONITOR_SEARCH_TERMS:-}"
  if [ -n "$configured" ]; then
    IFS=',' read -r -a configured_terms <<< "$configured"
    local count="${#configured_terms[@]}"
    local index=$((($(date +%s) / 60) % count))
    printf '%s' "${configured_terms[$index]}"
    return
  fi

  local count="${#DEFAULT_TERMS[@]}"
  local index=$((($(date +%s) / 60) % count))
  printf '%s' "${DEFAULT_TERMS[$index]}"
}

timing_value() {
  local header="$1"
  local name="$2"
  awk -v wanted="$name" '
    BEGIN { RS=","; FS=";" }
    {
      key=$1
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key != wanted) next
      for (i = 2; i <= NF; i++) {
        part=$i
        gsub(/^[ \t]+|[ \t]+$/, "", part)
        if (part ~ /^dur=/) {
          sub(/^dur=/, "", part)
          print int(part + 0.5)
          exit
        }
      }
    }
  ' <<< "$header"
}

check_search() {
  local term url tmpdir headers body curl_meta status time_total elapsed_ms server_timing total_ms quickwit_ms
  term="$(pick_term | xargs)"
  url="${BASE_URL%/}/api/search?query=${term}&sort=date_desc&offset=0&limit=24"
  tmpdir="$(mktemp -d)"
  headers="$tmpdir/headers"
  body="$tmpdir/body"

  local ip_arg=()
  if [ "$CURL_IP_VERSION" = "4" ]; then
    ip_arg=(--ipv4)
  elif [ "$CURL_IP_VERSION" = "6" ]; then
    ip_arg=(--ipv6)
  fi

  if ! curl_meta="$(curl -sS -L "${ip_arg[@]}" \
    --max-time "$SEARCH_TIMEOUT_SECONDS" \
    -H "user-agent: woozi-monitor/1.0" \
    -D "$headers" \
    -o "$body" \
    -w "%{http_code} %{time_total}" \
    "$url" 2>&1)"; then
    record_search_degraded critical search_unreachable "Search endpoint unreachable" "term=${term} error=${curl_meta}"
    rm -rf "$tmpdir"
    return
  fi

  status="$(awk '{print $1}' <<< "$curl_meta")"
  time_total="$(awk '{print $2}' <<< "$curl_meta")"
  elapsed_ms="$(awk -v seconds="$time_total" 'BEGIN { print int((seconds * 1000) + 0.5) }')"
  server_timing="$(awk 'BEGIN { IGNORECASE=1 } /^server-timing:/ { sub(/^[^:]+:[ \t]*/, ""); value=$0 } END { print value }' "$headers" | tr -d '\r')"
  total_ms="$(timing_value "$server_timing" total)"
  quickwit_ms="$(timing_value "$server_timing" quickwit)"
  total_ms="${total_ms:-$elapsed_ms}"
  quickwit_ms="${quickwit_ms:-0}"

  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    record_search_degraded critical search_http_error "Search endpoint returned an error" "status=${status} total_ms=${total_ms} term=${term}"
  elif [ "$total_ms" -ge "$SEARCH_CRITICAL_MS" ]; then
    record_search_degraded critical search_critical_slow "Search is critically slow" "total_ms=${total_ms} quickwit_ms=${quickwit_ms} term=${term}"
  elif [ "$total_ms" -ge "$SEARCH_WARN_MS" ] || [ "$quickwit_ms" -ge "$QUICKWIT_WARN_MS" ]; then
    record_search_degraded warning search_slow "Search is slow" "total_ms=${total_ms} quickwit_ms=${quickwit_ms} term=${term}"
  else
    record_search_ok
  fi

  rm -rf "$tmpdir"
}

check_disk() {
  local line used_percent
  line="$(df -Pk / | tail -n 1)"
  used_percent="$(awk '{ gsub(/%/, "", $5); print $5 }' <<< "$line")"
  if [ "$used_percent" -ge "$DISK_CRITICAL_PERCENT" ]; then
    alert critical disk_critical "Root disk is critically full" "used_percent=${used_percent} df=${line}"
  elif [ "$used_percent" -ge "$DISK_WARN_PERCENT" ]; then
    alert warning disk_warning "Root disk is getting full" "used_percent=${used_percent} df=${line}"
  fi
}

check_containers() {
  local line name restarts status worker cache_output cache_kb split_count cache_gb
  while read -r name restarts status; do
    [ -n "${name:-}" ] || continue
    if [ "$status" != "running" ]; then
      alert critical "container_${name}_not_running" "Container is not running" "name=${name} status=${status}"
    fi
    if [ "$restarts" -gt "$CONTAINER_RESTART_WARN" ]; then
      alert warning "container_${name}_restarted" "Container has restarted" "name=${name} restarts=${restarts}"
    fi
  done < <(docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.Status}}' woozi-quickwit-1 woozi-openbesluitvorming-1 | sed 's#^/##')

  # The worker used to run only during catch-up windows; since July 2026 it is
  # expected to run permanently (a missing worker silently freezes all imports
  # — bitten for 11 days when a deploy scaled it to 0).
  worker="$(docker ps --filter name=woozi-worker --filter status=running --format '{{.Names}}' || true)"
  if [ "$EXPECT_WORKER" = "1" ] && [ -z "$worker" ]; then
    alert critical worker_not_running "Import worker is not running" "expected>=1 replica; scale with: docker compose up -d --scale worker=1 worker (set WOOZI_MONITOR_EXPECT_WORKER=0 to silence during intentional scale-down)"
  fi

  cache_output="$(docker exec woozi-quickwit-1 sh -lc 'du -sk /quickwit/qwdata/searcher-split-cache 2>/dev/null; find /quickwit/qwdata/searcher-split-cache -maxdepth 1 -type f 2>/dev/null | wc -l')"
  cache_kb="$(sed -n '1s/[[:space:]].*$//p' <<< "$cache_output")"
  split_count="$(sed -n '2p' <<< "$cache_output" | xargs)"
  # "Cold" is relative to what's actually live, not a fixed historical count
  # -- the janitor (see check_quickwit_split_cache_pollution) now keeps the
  # cache trimmed close to the published-split count as its healthy steady
  # state, so a stale absolute threshold from before the janitor existed
  # fired as pure noise once the live split count settled lower than that
  # constant. Alert only when the cache holds meaningfully less than what's
  # actually published -- a real sign of a cold/just-recreated cache.
  if [ -n "$split_count" ]; then
    local published_now
    published_now="$(docker exec woozi-quickwit-1 sh -c \
      "grep -o '\"split_state\":[[:space:]]*\"Published\"' '/quickwit/qwdata/${QUICKWIT_INDEX_ROOT_PREFIX}/${QUICKWIT_INDEX_ID}/metastore.json' 2>/dev/null | wc -l" \
      2>/dev/null | xargs || echo 0)"
    if [ "${published_now:-0}" -gt 0 ] && [ "$split_count" -lt "$((published_now * QUICKWIT_MIN_CACHE_SPLITS / 100))" ]; then
      cache_gb="$(awk -v kb="${cache_kb:-0}" 'BEGIN { print int((kb / 1024 / 1024) + 0.5) }')"
      alert warning quickwit_cache_cold "Quickwit split cache looks cold" "split_count=${split_count} published_splits=${published_now} cache_gb=${cache_gb}"
    fi
  fi
}

ops_query() {
  sqlite3 -readonly "$OPS_DB" "$1" 2>/dev/null
}

check_imports() {
  local last_finished hours_since queued running stuck_minutes extract_failures

  if ! command -v sqlite3 >/dev/null 2>&1; then
    alert warning import_check_failed "Import check failed" "sqlite3 not installed on host"
    return
  fi
  if [ ! -f "$OPS_DB" ]; then
    alert warning import_check_failed "Import check failed" "ops db not found at ${OPS_DB}"
    return
  fi

  # 1. No completed run in IMPORT_STALL_HOURS: the pipeline is dead. The daily
  # scheduler enqueues every night and backfills run continuously, so >26h of
  # silence is never normal.
  last_finished="$(ops_query "SELECT COALESCE(MAX(finished_at), '') FROM ingest_run WHERE status IN ('succeeded', 'partial')")"
  if [ -n "$last_finished" ]; then
    hours_since="$(ops_query "SELECT CAST((julianday('now') - julianday('$last_finished')) * 24 AS INTEGER)")"
    if [ -n "$hours_since" ] && [ "$hours_since" -ge "$IMPORT_STALL_HOURS" ]; then
      alert critical import_stalled "No completed import in ${hours_since}h" "last_finished=${last_finished} threshold_hours=${IMPORT_STALL_HOURS}"
    fi
  fi

  # 2. Queue has work but nothing is running: the worker is gone or wedged.
  # Catches a missing worker within QUEUE_STUCK_MINUTES instead of after 26h.
  queued="$(ops_query "SELECT COUNT(*) FROM ingest_run WHERE status = 'queued'")"
  running="$(ops_query "SELECT COUNT(*) FROM ingest_run WHERE status = 'running'")"
  if [ "${queued:-0}" -gt 0 ] && [ "${running:-0}" -eq 0 ]; then
    stuck_minutes="$(ops_query "SELECT CAST((julianday('now') - julianday(MIN(started_at))) * 1440 AS INTEGER) FROM ingest_run WHERE status = 'queued'")"
    if [ -n "$stuck_minutes" ] && [ "$stuck_minutes" -ge "$QUEUE_STUCK_MINUTES" ]; then
      alert critical import_queue_stuck "Import queue has work but nothing is running" "queued=${queued} oldest_queued_minutes=${stuck_minutes}"
    fi
  fi

  # 3. Extraction failure *rate*: new extract/download issues since the
  # previous monitor tick, tracked via a rowid high-water mark. A cumulative
  # 6h window kept paging CRITICAL for hours after an incident was already
  # fixed (July 2026); a per-tick delta starts and stops with the problem.
  # Page-limit notices ("only the first 40 pages") are informational, not
  # failures, and are excluded. So are 4xx responses from the *source* system
  # (document deleted or restricted at e.g. Notubiz): those are data quality,
  # not system health, and deep-history backfills hit them by the hundreds per
  # hour. 5xx, timeouts and S3 errors still count.
  local max_rowid prev_rowid extract_failures
  max_rowid="$(ops_query "SELECT COALESCE(MAX(rowid), 0) FROM ingest_run_issue")"
  prev_rowid="$(cat "$STATE_DIR/extract_issue_rowid" 2>/dev/null || echo "")"
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$max_rowid" > "$STATE_DIR/extract_issue_rowid"
  if [ -z "$prev_rowid" ] || ! [[ "$prev_rowid" =~ ^[0-9]+$ ]] || [ "$max_rowid" -le "$prev_rowid" ]; then
    return
  fi
  extract_failures="$(ops_query "SELECT COUNT(*) FROM ingest_run_issue WHERE rowid > $prev_rowid AND step IN ('extract_text', 'download_document') AND severity = 'error' AND message NOT LIKE '%Source returned 40%' AND message NOT LIKE '%Request failed 404%'")"
  if [ "${extract_failures:-0}" -ge "$EXTRACT_FAIL_CRITICAL" ]; then
    alert critical extract_failures "Document extraction is failing at scale" "new_failures_this_interval=${extract_failures} threshold=${EXTRACT_FAIL_CRITICAL}"
  elif [ "${extract_failures:-0}" -ge "$EXTRACT_FAIL_WARN" ]; then
    alert warning extract_failures "Document extraction failure rate is elevated" "new_failures_this_interval=${extract_failures} threshold=${EXTRACT_FAIL_WARN}"
  fi
}

check_scale_down() {
  # Event-driven reminder: fires only when the backfill/queue has actually
  # drained while an enlarged extraction fleet is still configured (and
  # costing money). At most one alert per SCALE_DOWN_REMIND_SECONDS.
  local hosts active state_file now previous
  hosts="$(tr ',' '\n' <<< "${WOOZI_EXTRACTION_SERVICE_URL:-}" | grep -c . || true)"
  if [ "${hosts:-0}" -le "$SCALE_DOWN_BASELINE_HOSTS" ]; then
    return
  fi
  [ -f "$OPS_DB" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  active="$(ops_query "SELECT COUNT(*) FROM ingest_run WHERE status IN ('queued', 'running')")"
  if [ -z "$active" ] || [ "$active" -gt "$SCALE_DOWN_QUEUE_THRESHOLD" ]; then
    return
  fi

  state_file="$STATE_DIR/extraction_scale_down_reminder"
  now="$(date +%s)"
  previous="$(cat "$state_file" 2>/dev/null || echo 0)"
  if [ $((now - previous)) -lt "$SCALE_DOWN_REMIND_SECONDS" ]; then
    return
  fi
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$now" > "$state_file"
  alert warning extraction_scale_down "Import queue drained: scale the extraction fleet back down" "active_runs=${active} extraction_hosts=${hosts} baseline=${SCALE_DOWN_BASELINE_HOSTS}; set extraction_server_count in infra/terraform.tfvars, tofu apply, then update WOOZI_EXTRACTION_SERVICE_URL in /opt/woozi/.env and recreate the workers"
}

check_backups() {
  # scripts/backup_state.ts touches this stamp after each successful backup.
  local stamp_file stamp_age_hours
  stamp_file="$(dirname "$OPS_DB")/.woozi-backup-stamp"
  if [ "$BACKUP_STALE_HOURS" -le 0 ]; then
    return
  fi
  if [ ! -f "$stamp_file" ]; then
    alert warning backup_missing "No state backup has ever completed" "expected_stamp=${stamp_file} (install scripts/install-production-backup.sh)"
    return
  fi
  stamp_age_hours=$((($(date +%s) - $(stat -c %Y "$stamp_file" 2>/dev/null || echo 0)) / 3600))
  if [ "$stamp_age_hours" -ge "$BACKUP_STALE_HOURS" ]; then
    alert warning backup_stale "State backup is stale" "age_hours=${stamp_age_hours} threshold_hours=${BACKUP_STALE_HOURS}"
  fi
}

check_worker_fds() {
  # See WORKER_FD_MAX above. Reads fd counts from /proc for the worker deno
  # processes; when any exceeds the cap, restarts the worker containers
  # (self-heal) and sends one warning so the event stays visible.
  local pid fds max_fds=0
  if [ "$WORKER_FD_MAX" -le 0 ] || ! command -v docker >/dev/null 2>&1; then
    return
  fi
  for pid in $(pgrep -f 'deno run -A src/worker.ts' || true); do
    fds="$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)"
    [ "$fds" -gt "$max_fds" ] && max_fds="$fds"
  done

  # Diagnostic breadcrumbs while a leak is building: sample live connections
  # per peer inside the worker's own network namespace (host-side ss sees
  # nothing — the containers have their own netns). This is how the July 2026
  # leak was pinned to CLOSE-WAIT sockets to the S3 endpoint (AWS SDK on
  # Deno's node-compat; fixed by replacing the SDK with aws4fetch). Kept as
  # a tripwire in case a leak to another peer ever shows up.
  if [ "$max_fds" -gt 2000 ]; then
    {
      printf '%s max_fds=%s\n' "$(date -u +%FT%TZ)" "$max_fds"
      pid="$(pgrep -f 'deno run -A src/worker.ts' | head -n1)"
      [ -n "$pid" ] && nsenter -t "$pid" -n ss -tan 2>/dev/null |
        awk '{print $1, $5}' | sed 's/:[0-9]*$//' |
        sort | uniq -c | sort -rn | head -8
    } >> "$STATE_DIR/fd_leak_peers.log" 2>/dev/null || true
  fi

  if [ "$max_fds" -le "$WORKER_FD_MAX" ]; then
    return
  fi
  docker restart $(docker ps -q --filter 'name=woozi-worker') >/dev/null 2>&1 || true
  alert warning worker_fd_leak "Worker fd leak: restarted the import workers" "max_fds=${max_fds} threshold=${WORKER_FD_MAX}; interrupted runs are requeued by reconcile"
}

quickwit_split_cache_heal_on_cooldown() {
  local state_file="$STATE_DIR/quickwit_split_cache_heal_last" now previous
  now="$(date +%s)"
  previous="$(cat "$state_file" 2>/dev/null || echo 0)"
  [ $((now - previous)) -lt "$QUICKWIT_SPLIT_CACHE_HEAL_COOLDOWN_SECONDS" ]
}

mark_quickwit_split_cache_healed() {
  mkdir -p "$STATE_DIR"
  date +%s > "$STATE_DIR/quickwit_split_cache_heal_last"
}

quickwit_split_cache_full_restart() {
  # Disruptive fallback: stops the workers and Quickwit, so only reach for
  # it when the (non-disruptive) janitor below couldn't keep the cache
  # under control on its own -- e.g. it can't run (no python3 on the host)
  # or Quickwit stopped responding to `docker exec`.
  local cache_files="$1" published_splits="$2" ratio="$3" workers
  quickwit_split_cache_heal_on_cooldown && return 0

  workers="$(docker ps --format '{{.Names}}' --filter 'name=woozi-worker' | tr '\n' ' ')"
  # shellcheck disable=SC2086
  [ -z "$workers" ] || docker stop $workers >/dev/null 2>&1 || true
  docker stop woozi-quickwit-1 >/dev/null 2>&1 || true
  docker run --rm -v woozi_quickwit-data:/qw alpine \
    sh -c 'rm -rf /qw/searcher-split-cache && mkdir -p /qw/searcher-split-cache' >/dev/null 2>&1 || true
  (cd /opt/woozi && docker compose -f docker-compose.production.yml up -d quickwit) >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    # Quickwit has no host-published port by design (compose network only),
    # so the readiness probe has to run inside the container.
    [ "$(docker exec woozi-quickwit-1 curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:7280/health/readyz 2>/dev/null || true)" = "200" ] && break
    sleep 2
  done
  # shellcheck disable=SC2086
  [ -z "$workers" ] || docker start $workers >/dev/null 2>&1 || true

  mark_quickwit_split_cache_healed
  alert warning quickwit_split_cache_polluted "Quickwit split cache was polluted: purged and restarted" "cache_files=${cache_files} published_splits=${published_splits} ratio=${ratio}x; the non-disruptive janitor could not keep up (see logs); interrupted runs are requeued by reconcile; structural fix is the planned reindex onto local storage with a normal commit_timeout_secs (docs/search-performance-quickwit-s3.md)"
}

check_quickwit_split_cache_pollution() {
  # The searcher split cache accumulates files for splits the metastore no
  # longer lists as Published (merged away under the index's
  # commit_timeout_secs: 1 churn) faster than Quickwit's own LRU evicts them
  # -- because by *byte size* they fit the configured budget, they just
  # never get evicted, and crowd out large/less-recently-touched live splits
  # instead. On 2026-07-17/18 this reached 13-46x live-vs-cached and made
  # cold searches re-fetch from S3 (5-50s instead of sub-second).
  #
  # Fix without disrupting ingest: every cycle, diff the cache directory's
  # filenames (split_id.split) against the metastore's Published split_ids
  # and delete only the orphans, live, with Quickwit and the workers running
  # the whole time (Linux allows unlinking a file a process still has open;
  # it's simply not evicting these on its own). Only fall back to the
  # disruptive full stop/wipe/restart if this can't run or doesn't help.
  local cache_dir="/quickwit/qwdata/searcher-split-cache"
  local metastore_path="/quickwit/qwdata/${QUICKWIT_INDEX_ROOT_PREFIX}/${QUICKWIT_INDEX_ID}/metastore.json"
  local tmp_meta tmp_cache tmp_orphans cache_files published_splits orphan_count ratio

  [ "$QUICKWIT_SPLIT_CACHE_POLLUTION_RATIO" -gt 0 ] || return 0
  command -v docker >/dev/null 2>&1 || return 0
  docker ps --format '{{.Names}}' | grep -qx woozi-quickwit-1 || return 0

  cache_files="$(docker exec woozi-quickwit-1 sh -c \
    "find '${cache_dir}' -maxdepth 1 -type f 2>/dev/null | wc -l" 2>/dev/null | xargs || true)"
  [ -n "$cache_files" ] && [ "$cache_files" -ge "$QUICKWIT_SPLIT_CACHE_POLLUTION_MIN_FILES" ] || return 0

  if ! command -v python3 >/dev/null 2>&1; then
    published_splits="$(docker exec woozi-quickwit-1 sh -c \
      "grep -o '\"split_state\":[[:space:]]*\"Published\"' '${metastore_path}' 2>/dev/null | wc -l" 2>/dev/null | xargs || true)"
    [ -n "$published_splits" ] && [ "$published_splits" -gt 0 ] || return 0
    ratio="$((cache_files / published_splits))"
    [ "$ratio" -ge "$QUICKWIT_SPLIT_CACHE_POLLUTION_RATIO" ] || return 0
    quickwit_split_cache_full_restart "$cache_files" "$published_splits" "$ratio"
    return 0
  fi

  tmp_meta="$(mktemp)"; tmp_cache="$(mktemp)"; tmp_orphans="$(mktemp)"
  docker exec woozi-quickwit-1 cat "$metastore_path" > "$tmp_meta" 2>/dev/null || true
  docker exec woozi-quickwit-1 sh -c "ls '${cache_dir}'" > "$tmp_cache" 2>/dev/null || true

  python3 - "$tmp_meta" "$tmp_cache" > "$tmp_orphans" 2>/dev/null << 'PY' || true
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
published = {s.get("split_id") for s in data.get("splits", []) if s.get("split_state") == "Published"}
for line in open(sys.argv[2]):
    name = line.strip()
    if name.endswith(".split") and name[: -len(".split")] not in published:
        print(name)
PY

  published_splits="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for s in d.get('splits',[]) if s.get('split_state')=='Published'))" "$tmp_meta" 2>/dev/null || echo 0)"
  orphan_count="$(wc -l < "$tmp_orphans" | xargs)"

  if [ "$orphan_count" -gt 0 ] && [ -s "$tmp_meta" ]; then
    docker exec -i woozi-quickwit-1 sh -c "cd '${cache_dir}' && xargs -r rm -f" < "$tmp_orphans" >/dev/null 2>&1 || true
    printf '{"event":"quickwit_split_cache_janitor","cache_files":%s,"published_splits":%s,"orphans_removed":%s}\n' \
      "$cache_files" "${published_splits:-0}" "$orphan_count"
  fi
  rm -f "$tmp_meta" "$tmp_cache" "$tmp_orphans"

  # Fallback: metastore unreadable, or the janitor genuinely can't keep pace
  # with the churn rate. Re-measure the cache *after* cleanup -- the deletion
  # above already brings the count down in the common case, and comparing
  # against the pre-cleanup count would trigger a needless restart on every
  # single successful janitor run.
  if [ -z "$published_splits" ] || [ "$published_splits" -le 0 ]; then
    quickwit_split_cache_full_restart "$cache_files" "${published_splits:-0}" "n/a"
    return 0
  fi
  cache_files="$(docker exec woozi-quickwit-1 sh -c \
    "find '${cache_dir}' -maxdepth 1 -type f 2>/dev/null | wc -l" 2>/dev/null | xargs || echo "$cache_files")"
  ratio="$((cache_files / published_splits))"
  [ "$ratio" -ge "$QUICKWIT_SPLIT_CACHE_POLLUTION_RATIO" ] || return 0
  quickwit_split_cache_full_restart "$cache_files" "$published_splits" "$ratio"
}

alert_is_unsuppressed() {
  local key="$1"
  local state_file="$STATE_DIR/$key"
  local now previous cooldown
  now="$(date +%s)"
  previous="$(cat "$state_file" 2>/dev/null || echo 0)"
  cooldown="$ALERT_COOLDOWN_SECONDS"
  # Slow-search warnings recur for hours whenever heavy indexing (backfill,
  # repair rounds) competes with Quickwit; once an hour is informative,
  # every 2-min interval is noise. Unreachable stays on the normal cooldown.
  if [ "$key" = "search_slow" ]; then
    cooldown="${SEARCH_SLOW_ALERT_COOLDOWN_SECONDS:-3600}"
  fi
  [ $((now - previous)) -ge "$cooldown" ]
}

mark_alert_sent() {
  local key="$1"
  mkdir -p "$STATE_DIR"
  date +%s > "$STATE_DIR/$key"
}

send_webhook() {
  local webhook="${WOOZI_ALERT_WEBHOOK_URL:-}"
  local format="${WOOZI_ALERT_WEBHOOK_FORMAT:-auto}"
  local unsuppressed=()
  local item severity key title details critical_count=0 text=""

  [ -n "$webhook" ] || return 0

  for item in "${ALERTS[@]}"; do
    IFS='|' read -r severity key title details <<< "$item"
    if alert_is_unsuppressed "$key"; then
      unsuppressed+=("$item")
      [ "$severity" = "critical" ] && critical_count=$((critical_count + 1))
    fi
  done

  [ "${#unsuppressed[@]}" -gt 0 ] || return 0

  if [ "$critical_count" -gt 0 ]; then
    text="CRITICAL OpenBesluitvorming monitor: ${#unsuppressed[@]} alert(s)"
  else
    text="WARNING OpenBesluitvorming monitor: ${#unsuppressed[@]} alert(s)"
  fi

  for item in "${unsuppressed[@]}"; do
    IFS='|' read -r severity key title details <<< "$item"
    text="${text}
- ${title}: ${details}"
  done

  if [ "$format" = "auto" ] && [[ "$webhook" == https://discord.com/api/webhooks/* ]]; then
    format="discord"
  fi

  if [ "$format" = "discord" ]; then
    local escaped
    escaped="$(python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))' <<< "$text")"
    curl -sS -X POST -H "content-type: application/json" --data-binary "{\"content\":${escaped}}" "$webhook" >/dev/null
  else
    curl -sS -X POST -H "content-type: text/plain; charset=utf-8" --data-binary "$text" "$webhook" >/dev/null
  fi

  for item in "${unsuppressed[@]}"; do
    IFS='|' read -r severity key title details <<< "$item"
    mark_alert_sent "$key"
  done
}

main() {
  check_search
  check_disk
  check_containers
  check_imports
  check_backups
  check_scale_down
  check_worker_fds
  check_quickwit_split_cache_pollution

  if [ "${#ALERTS[@]}" -eq 0 ]; then
    printf '{"event":"monitor_run","ok":true,"alert_count":0}\n'
    return 0
  fi

  printf '{"event":"monitor_run","ok":false,"alert_count":%s}\n' "${#ALERTS[@]}"
  for item in "${ALERTS[@]}"; do
    IFS='|' read -r severity key title details <<< "$item"
    printf '%s %s: %s (%s)\n' "$severity" "$key" "$title" "$details"
  done

  send_webhook

  for item in "${ALERTS[@]}"; do
    IFS='|' read -r severity key title details <<< "$item"
    if [ "$severity" = "critical" ]; then
      return 2
    fi
  done
  return 1
}

main "$@"
