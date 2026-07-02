#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${WOOZI_MONITOR_BASE_URL:-https://openbesluitvorming.nl}"
SEARCH_TIMEOUT_SECONDS="${WOOZI_MONITOR_SEARCH_TIMEOUT_SECONDS:-15}"
SEARCH_WARN_MS="${WOOZI_MONITOR_SEARCH_WARN_MS:-2000}"
SEARCH_CRITICAL_MS="${WOOZI_MONITOR_SEARCH_CRITICAL_MS:-8000}"
QUICKWIT_WARN_MS="${WOOZI_MONITOR_QUICKWIT_WARN_MS:-1500}"
DISK_WARN_PERCENT="${WOOZI_MONITOR_DISK_WARN_PERCENT:-80}"
DISK_CRITICAL_PERCENT="${WOOZI_MONITOR_DISK_CRITICAL_PERCENT:-90}"
QUICKWIT_MIN_CACHE_SPLITS="${WOOZI_MONITOR_QUICKWIT_MIN_CACHE_SPLITS:-60}"
CONTAINER_RESTART_WARN="${WOOZI_MONITOR_CONTAINER_RESTART_WARN:-0}"
STATE_DIR="${WOOZI_MONITOR_STATE_DIR:-/tmp/woozi-monitor-alerts}"
ALERT_COOLDOWN_SECONDS="${WOOZI_MONITOR_ALERT_COOLDOWN_SECONDS:-900}"
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

  worker="$(docker ps --filter name=woozi-worker --format '{{.Names}} {{.Status}}' || true)"
  if [ -n "$worker" ]; then
    alert warning worker_running "Worker container is running" "worker=${worker}"
  fi

  cache_output="$(docker exec woozi-quickwit-1 sh -lc 'du -sk /quickwit/qwdata/searcher-split-cache 2>/dev/null; find /quickwit/qwdata/searcher-split-cache -maxdepth 1 -type f 2>/dev/null | wc -l')"
  cache_kb="$(sed -n '1s/[[:space:]].*$//p' <<< "$cache_output")"
  split_count="$(sed -n '2p' <<< "$cache_output" | xargs)"
  if [ -n "$split_count" ] && [ "$split_count" -lt "$QUICKWIT_MIN_CACHE_SPLITS" ]; then
    cache_gb="$(awk -v kb="${cache_kb:-0}" 'BEGIN { print int((kb / 1024 / 1024) + 0.5) }')"
    alert warning quickwit_cache_cold "Quickwit split cache looks cold" "split_count=${split_count} cache_gb=${cache_gb}"
  fi
}

alert_is_unsuppressed() {
  local key="$1"
  local state_file="$STATE_DIR/$key"
  local now previous
  now="$(date +%s)"
  previous="$(cat "$state_file" 2>/dev/null || echo 0)"
  [ $((now - previous)) -ge "$ALERT_COOLDOWN_SECONDS" ]
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
