# Search performance: Quickwit, S3, and local cache

Date: 2026-07-01. Updated 2026-07-17 with the dead-split cache-pollution
incident and the prevention plan (see the sections at the end).

## Summary

Production search latency is currently dominated by Quickwit, not by the Svelte
frontend, Caddy, PDF page rendering, or S3 thumbnail previews.

The immediate issue is the combination of:

- a Quickwit index stored in Hetzner Object Storage;
- public text search scanning 71 Quickwit splits;
- too little local split cache for the full hot search set;
- large stored search hit payloads due to broad/dynamic indexing.

We should not buy a new node yet. The cheaper path is:

1. keep Quickwit split cache large enough to hold the active splits;
2. reclaim disk space from old Docker images;
3. move Quickwit data/cache to a larger local volume if needed;
4. build a smaller public-search projection/index.

A new server only makes sense after we have reduced the index payload and proven
that CPU/RAM, rather than object-storage reads or document fetch payloads, is the
remaining bottleneck.

## Observed production behavior

Repeated searches for the same term are misleading because Quickwit/object-store
cache gets warm. Always measure with new query terms.

Before the cache/config changes, cold terms showed multi-second or failed search
latency:

| Query | Result | Timing |
| --- | --- | --- |
| `dakgoot` | HTTP 500 | ~16.1s |
| `vlonder` | HTTP 500 | ~16.1s |
| `aardwarmte` | HTTP 200 | ~8.6s |
| `windturbinepark` | HTTP 500 | ~16.2s |

`server-timing` consistently showed almost all time inside `quickwit`.

After deploying `count_all: false`, Quickwit logs confirmed:

- `max_hits: 25`
- `count_hits: Underestimate`
- `snippet_fields: ["content", "name"]`
- `num_splits=71`

That improved some cases, but did not remove cold-tail latency. Direct Quickwit
tests without snippets still produced large responses and slow/timeout behavior:

| Query | Snippets | Result |
| --- | --- | --- |
| `bomenkapplan` | no | ~8.1s, ~1.2MB response |
| `afvalpasregeling` | no | timed out after 15s |
| `fietskluizen` | no | timed out after 15s |
| `parkeerdrukte` | yes | ~0.7s, ~1.1MB response |
| `wijkbibliotheek` | yes | ~0.4s, ~1.6MB response |

This means snippet generation is not the whole problem. Quickwit still fetches
large stored documents for hits.

## Current production host

Measured on `woozi-1`:

- 4 vCPU
- 8GB RAM
- 150GB root disk
- disk was around 89% full during investigation
- Quickwit searcher split cache after warm-up: about 22GB
- Quickwit split cache file count: 71

The previous cache limit was effectively too small:

- configured default: 10GB
- active search split set: about 21-22GB

That forced frequent S3/object-storage reads for cold terms.

Production has now been changed to:

```yaml
QUICKWIT_SPLIT_CACHE_MAX_NUM_BYTES: 24G
QUICKWIT_SPLIT_CACHE_NUM_CONCURRENT_DOWNLOADS: 4
```

After the cache filled, new terms mostly improved:

| Query | Timing |
| --- | --- |
| `speelruimtebeleid` | ~302ms |
| `laadinfra` | ~770ms |
| `subsidieplafond` | ~73ms |
| `fietsoversteek` | ~97ms |
| `dorpsontwikkelingsplan` external | ~414ms total |

There was still at least one tail:

| Query | Timing |
| --- | --- |
| `mantelzorgwoning` | ~4.7s |

So larger split cache helps materially, but it is not the structural fix.

## What the Quickwit docs imply

Relevant Quickwit docs:

- `docs/configuration/node-config.md`
- `docs/configuration/index-config.md`
- `docs/overview/architecture.md`
- `docs/deployment/deployment-modes.md`
- `docs/deployment/cluster-sizing.md`

Key points:

- Quickwit stores index data as splits.
- For distributed/object-storage deployments, splits live in object storage.
- The searcher has local caches:
  - `fast_field_cache_capacity`
  - `split_footer_cache_capacity`
  - `partial_request_cache_capacity`
  - `split_cache.max_num_bytes`
  - `split_cache.max_num_splits`
  - `split_cache.num_concurrent_downloads`
- Quickwit has a split cache, but not a rich general query/result/predicate cache
  that eliminates object-store costs for arbitrary cold searches.
- Dynamic mapping defaults can store/index unmapped fields broadly.
- `store_source` and explicit field mappings matter if we want smaller stored hit
  payloads.
- Quickwit docs recommend enough local data-dir space for split cache and index
  build work; local SSD/disk matters for performance.

The current public index uses `doc_mapping.mode: dynamic`. That is convenient
for prototyping, but risky for search latency because it tends to keep more
stored source/payload around than the public result UI needs.

## Current index shape problem

The public search UI only needs:

- entity id
- entity type
- parent entity id for page hits
- page number
- organization/source display fields
- title/name
- date/sort date
- compact download/PDF metadata
- page count
- a small snippet or summary

But the current Quickwit hits can include much heavier stored data:

- `content`
- compact-but-still-large `payload`
- agenda structures for meetings
- page markdown for document page chunks

The public API shapes this down before returning it to the browser, but the
expensive part has already happened: Quickwit has fetched and serialized the
stored hit documents.

Quickwit 0.8 rejected a tested `fields` search request parameter as an unknown
field, so we cannot cheaply ask the current search endpoint to return only a
small subset of stored fields.

## Options

### Option A: keep current node, clean disk, enlarge split cache

Do this first.

Actions:

- prune unused Docker images on production;
- raise `QUICKWIT_SPLIT_CACHE_MAX_NUM_BYTES` to 32-48GB after reclaiming space;
- keep `QUICKWIT_SPLIT_CACHE_NUM_CONCURRENT_DOWNLOADS` at 4 unless object storage
  starts throttling;
- keep workers scaled to zero unless intentionally importing.

Pros:

- cheapest;
- low code risk;
- directly addresses the measured S3 split-cache issue;
- likely enough for current public traffic once cache is warm.

Cons:

- cold-after-restart terms can still be slow while cache refills;
- the stored-hit payload problem remains;
- disk pressure can return as the index grows.

### Option B: add a Hetzner Volume for Quickwit data/cache

Prefer this before a new node if disk is the only constraint.

Use a block volume mounted for Quickwit data, for example:

```text
/quickwit/qwdata
```

Then set cache higher, for example 64-100GB, depending on volume size.

Pros:

- much cheaper than another server;
- avoids root disk pressure;
- keeps current architecture simple;
- enough room for split cache growth.

Cons:

- requires a short maintenance window to move Docker volume data or remount;
- remote block storage may be slower than local NVMe, but still likely better
  than repeated object-storage split downloads.

### Option C: compact public-search projection/index

This is the real structural fix.

Create a new projection version, for example `search-v3-compact`, with a new
Quickwit index config:

- avoid `mode: dynamic` for public search;
- set `store_source: false` if supported by the target Quickwit config;
- explicitly map only fields required by public search;
- keep large text indexed for full-text search, but avoid storing it as a large
  returned hit payload where possible;
- store only a small `summary_text` / `snippet_source` / `page_excerpt`;
- keep full markdown in S3 for detail requests, not in search hits;
- keep document metadata small and flat.

Potential split:

- `public-search` index: small result documents for UI;
- canonical/document markdown remains in S3;
- admin/export/detail flows use object storage or separate APIs when they need
  full content.

Pros:

- reduces Quickwit hit fetch/serialization;
- reduces response size between Quickwit and the web container;
- reduces cache pressure;
- makes latency less sensitive to object-storage roundtrips.

Cons:

- requires index versioning and reindex/reimport;
- needs focused tests for result shaping, snippets, page navigation, and detail
  lookup;
- not a same-hour ops patch.

### Option D: buy a new/dedicated search node

Only after A-C are evaluated.

A dedicated Quickwit search node can help if:

- the current host remains CPU-bound after cache is warm;
- the current host cannot keep enough disk/cache even with a volume;
- search traffic grows enough that web, Quickwit, and admin traffic need hard
  resource isolation.

It does not fix the current index shape by itself. If the search node still uses
S3-backed splits and returns large stored hits, cold-tail latency can remain.

## Recommended plan

1. **Immediate ops**
   - prune unused Docker images;
   - raise split cache to 40GB if disk allows;
   - keep monitoring cold terms with never-reused query words;
   - alert on disk >85%.

2. **Cheap infra**
   - if root disk is still tight, add a Hetzner Volume for `/quickwit/qwdata`;
   - target 64GB+ Quickwit split cache.

3. **Code/index work**
   - design `search-v3-compact`;
   - remove broad dynamic stored payloads from public search hits;
   - reindex into the compact projection;
   - compare cold and warm timings before switching default traffic.

4. **Only then consider a new node**
   - buy a new node only if measurements show CPU/RAM isolation is still needed.

## Measurement rules

Do not reuse query terms when testing cold performance. Repeated terms measure
warm cache and can make the system look healthy when arbitrary user searches are
still slow.

Use one fresh term per request, for example:

```sh
curl --max-time 25 -sS -D /tmp/search_headers -o /tmp/search_body \
  -w 'http=%{http_code} total=%{time_total} size=%{size_download}\n' \
  'https://openbesluitvorming.nl/api/search?query=<fresh-term>&sort=date_desc&offset=0&limit=24'

grep -i '^server-timing:' /tmp/search_headers
```

Interpretation:

- `quickwit` dominates: search/index/storage issue.
- `preview` dominates: thumbnail HEAD/cache path.
- `shape` dominates: web result shaping/deduping issue.
- `total` much larger than `search`: proxy/network/browser path.

## Monitoring added

Production monitoring should cover two layers:

1. structured app logs for slow API requests;
2. a synthetic monitor that periodically searches with rotating query terms and
   checks the host state.

The app emits JSON log lines with `event=http_request_perf` for slow `/api/*`
requests and 5xx responses. By default, `WOOZI_PERF_LOG_SLOW_MS=1000`; set
`WOOZI_PERF_LOG_ALL=1` temporarily if every API request needs to be logged.
Search logs include only query length/hash, not the raw query text.

The host monitor lives in `scripts/monitor-production.sh` and is installed with:

```sh
scripts/install-production-monitor.sh
```

It runs every two minutes through `woozi-monitor.timer` and checks:

- `/api/search` with rotating query terms, avoiding misleading warm-cache terms;
- `server-timing` totals and the `quickwit` phase;
- root disk usage;
- `openbesluitvorming` and `quickwit` container status/restarts;
- whether the ingest `worker` container is running during public serving;
- Quickwit split-cache file count and approximate cache size.

Set `WOOZI_ALERT_WEBHOOK_URL` in `/opt/woozi/.env` to receive notifications. The
script auto-detects Discord webhook URLs and otherwise sends plain-text webhook
payloads. Repeated alerts are suppressed with
`WOOZI_MONITOR_ALERT_COOLDOWN_SECONDS` (default 900 seconds).

Useful operational commands:

```sh
systemctl status woozi-monitor.timer
journalctl -u woozi-monitor.service -n 50 --no-pager
WOOZI_ALERT_WEBHOOK_URL= scripts/monitor-production.sh
```

## Incident 2026-07-17: dead splits polluted the searcher split cache

During the full-history backfill, cold search terms degraded from the usual
sub-second to 5-50s, with intermittent criticals and one 15s probe timeout.
Host resources (CPU, RAM, disk, I/O) were all healthy; repeated terms were
fast. The cache itself was the problem:

- the searcher split cache held **~1,950 files (38GB)** while the metastore
  listed only **43 published splits (32GB)** — the cache was almost entirely
  dead splits left behind by merge churn;
- the live splits (including one 25GB split holding 11.8M docs) kept getting
  evicted by that garbage, so cold terms re-fetched split data from Hetzner
  object storage on every query;
- the same object-storage endpoint was saturated by the running backfill
  (split uploads, merges, document-cache writes), which is why latency spiked
  into tens of seconds rather than the usual S3 roundtrip cost.

Root cause of the churn: the index was created with **`commit_timeout_secs: 1`**,
so every second of active ingest produces a tiny split that is later merged
away (merge policy `stable_log`, maturation 2 days). Thousands of short-lived
splits cycled through the cache and their files were never reclaimed. Quickwit
0.8 cannot change `commit_timeout_secs` on an existing index (no update
endpoint), so the churn itself cannot be stopped in place.

### Recovery procedure (verified)

Total interruption is about one minute; searches are cold for a few minutes
afterwards while the cache refills (~32GB at 8 concurrent downloads):

```sh
docker stop woozi-worker-1 woozi-worker-2 woozi-worker-3 woozi-worker-4
docker stop woozi-quickwit-1
docker run --rm -v woozi_quickwit-data:/qw alpine \
  sh -c 'rm -rf /qw/searcher-split-cache && mkdir -p /qw/searcher-split-cache'
cd /opt/woozi && docker compose -f docker-compose.production.yml up -d quickwit
docker start woozi-worker-1 woozi-worker-2 woozi-worker-3 woozi-worker-4
```

Workers are stopped first so no ingest batches fail against the restarting
Quickwit. `QUICKWIT_SPLIT_CACHE_NUM_CONCURRENT_DOWNLOADS=8` is now set in
`/opt/woozi/.env` (was 4) to speed up the refill. After recovery the
previously-critical terms measured 0.4-0.7s cold and ~0.14s warm.

Note: the live metastore is `/quickwit/qwdata/indexes-prod/woozi-events-prod/metastore.json`
(file metastore), while the index data lives at
`s3://woozi-dev/indexes-prod/woozi-events-prod` — the node config's
`default_index_root_uri: file://...` does not apply to this index because
`index_uri` was fixed at creation time. The same directory also contains
~1,900 stale local `.split` files (~20GB) from an earlier local-storage
period; they are unreferenced and can be deleted during the reindex.

## Prevention plan

Three layers, from root cause to safety net:

1. **Remove the churn source at the planned post-backfill reindex.** Create
   the next projection index with `commit_timeout_secs: 60-120` (only settable
   at creation time on Quickwit 0.8) and with a local `index_uri` (file://)
   instead of object storage. After query-time dedup is baked in, the index
   shrinks ~3.5x and fits comfortably on local disk. This removes the entire
   class of "cold search reads from an S3 endpoint the backfill is
   saturating", and makes the split cache irrelevant. This folds into the
   `search-v3-compact` work already described under Option C above.

2. **Detect cache pollution before users feel it.** Add a monitor check that
   compares the file count in `searcher-split-cache/` against the number of
   published splits in the metastore. Healthy is roughly 1:1; the incident
   ratio was 1,996:43. Alert at >3x with the recovery procedure in the alert
   text. The pollution built up over weeks and was trivially measurable the
   whole time — the existing search-slow probes only catch the symptom.

3. **Upgrade Quickwit at the reindex moment, not before.** Newer versions can
   update `commit_timeout_secs` on an existing index, which is attractive, but
   an upgrade mid-backfill is the wrong trade: the metastore migration is
   one-way (no downgrade), 0.9 replaced the ingest architecture that the
   worker pushes through continuously, and an upgrade cannot move `index_uri`
   off S3 anyway — so the reindex is still needed for the structural fix.
   Sequence at the reindex: upgrade Quickwit first, verify against the
   existing index, then create the new local-storage index on the new
   version, keeping the old S3 index as fallback until the new one is
   verified.
