# The next index: local storage, one operation

Date: 2026-09-02. Plan for the projection index that replaces
`woozi-events-v3b`. Background in
[`search-performance-quickwit-s3.md`](search-performance-quickwit-s3.md) (why)
and [`handover-split-cache-and-reindex.md`](handover-split-cache-and-reindex.md)
(what happened since). This document is the how, with the measurements that
changed the plan.

## What it settles

Three open items are one fresh index:

1. **#203, the timezone backlog.** Rows projected before 2026-08-28 carry a
   `start_date` two hours off. Re-projecting into the live index appends a
   second row with the same `time`, and the tie goes to whichever row Quickwit
   returns first. Only an empty index replaces anything.
2. **The split churn.** `commit_timeout_secs: 1` on an S3-backed index is why
   the searcher split cache exists, and the cache is why 150 lines of
   monitor script exist. A local index with a normal commit cadence needs
   neither.
3. **The duplicates** left by timed-out ingests during the v3b campaign and by
   the 2026-08-28 trial reindex of `dongen`.

## Measurements that changed the plan

### The index will not shrink 3.5x

The July estimate assumed query-time dedup would collapse the index. It
already did that once: v3b *is* a fresh reindex. Measured 2026-09-02:

| | rows |
|---|---|
| `woozi-events-v3b`, all rows | 44,647,042 |
| of which `DocumentPage` | 38,629,780 (86%) |
| of which `Document` | 5,623,682 |
| other primary rows | 393,580 |
| export log, unique entities | 5,570,607 |

Primary rows exceed unique entities by about 8%; those are the duplicates.
Page rows are the index, and a fresh projection produces the same pages. A v4
with the same doc mapping lands around **57-60 GB**, not 18. The real shrink
is Option C in the July document (stop storing `content` per page, map
explicitly) and that is a product change with its own tests. It is not part
of this operation.

### Where the splits can go

| disk | size | free | 4K random read |
|---|---|---|---|
| `/dev/sda` root, NVMe | 150 GB | 101 GB | 0.22 ms |
| `/dev/sdb` volume, `/mnt/quickwit-cache` | 147 GB | 79 GB | 2.01 ms |

Root cannot take it. A 60 GB index plus merge headroom (the four largest v3b
splits are 12-18 GB each; a merge holds inputs and output at once) plus the
indexer's own split store peaks near the free space, and the 2026-08-10
incident was exactly a root disk filling under a reindex.

The volume can, and its slowness is a non-issue for a reason the compose
comment missed: the split cache lives on that volume today, so every warm
search already reads splits from `/dev/sdb`. A local index there performs
like today's warm cache, with no cold misses to S3. The measured 0.39-0.43s
on `/api/search` is `/dev/sdb` performance.

So: the index goes on the volume, and the volume stops being a cache.

### Quickwit 0.9.0

Released 2026-07-25 (five weeks before this document). Tested locally against
our `quickwit.yaml` and `index-config.json`:

- boots on the checked-in node config unchanged;
- `PUT /api/v1/indexes/<id>` updates `commit_timeout_secs` on an existing
  index. Verified: 60 to 90 on a live index. **This means the churn on v3b can
  be stopped the day of the upgrade, before any reindex.**
- the file metastore is rewritten to format `0.9` **at startup**, not at
  first write: rehearsed on a copy of the production `indexes-prod`
  directory, the manifest and every metastore said `0.9` before any request
  was made, with all 26 published splits and 44.6M documents intact. 0.8.1
  then refuses to start on it (`unknown variant 0.9, expected 0.8`), so the
  rollback is the copy of the whole `indexes-prod` directory, not one file;
- 0.9 creates `otel-logs-v0_9` and `otel-traces-v0_9` for its own OTLP
  endpoint on first start, next to the existing `v0_7` pair. Expected, harmless;
- ingest V2 serves `/api/v1/<id>/ingest`. With `commit=wait_for` every batch
  waits the full `commit_timeout_secs`: measured 62s for one batch and 60s for
  four parallel batches at a timeout of 60. `commit=auto` returns in 20 ms.
  The worker's default stays `wait_for`; the campaign runs with
  `QUICKWIT_INGEST_COMMIT=auto`;
- the searcher split cache wraps **every** storage, file:// included. A
  local index would be copied into the cache split by split, doubling disk.
  `max_num_bytes: 0` does not disable it (verified: still caches). Disabling
  means removing the `searcher.split_cache` section from `quickwit.yaml`.

### The ingest client

`ensureIndex` posts the checked-in config verbatim, so a new index inherits
the node's S3 root and `commit_timeout_secs: 1`. Since this change the worker
honours `QUICKWIT_INDEX_URI`, `QUICKWIT_COMMIT_TIMEOUT_SECS` and
`QUICKWIT_INGEST_COMMIT` at creation and ingest time; production sets them per
worker through `WORKER_QUICKWIT_INDEX_URI`,
`WORKER_QUICKWIT_COMMIT_TIMEOUT_SECS` and `QUICKWIT_INGEST_COMMIT` in
`/opt/woozi/.env`. Verified end to end against 0.9.0: an index created with
`file://` URI and timeout 90 reports exactly that from `GET /api/v1/indexes`.

## Sequence

Each step has a check that decides whether the next one happens.

**0. Before touching anything.** `df` on both disks, the phantom check
(tally against disk) at zero, and a copy of the whole
`/var/lib/docker/volumes/woozi_quickwit-data/_data/indexes-prod` directory
(manifest plus every metastore, under 100 KB) outside the volume. Note the
current `/api/search` latency for comparison. Done 2026-09-02 11:21 UTC:
101 GB free on root, 79 GB on the volume, tally 65.2 GB against 65.2 GB on
disk, 26 published splits, cold searches 5-10s and warm 45-80 ms.

**1. Upgrade Quickwit to 0.9.0.** Change the image tag in
`docker-compose.production.yml`, deploy, restart Quickwit by hand (the deploy
does not). Search is unavailable for seconds. Check: `/api/v1/version` says
0.9.0, a phrase query and a date-sorted query against v3b return what they
returned before, the workers' next import succeeds. Rollback: the 0.8.1 tag
plus the metastore copy from step 0.

Done 2026-09-02 11:40 UTC. What it taught:

- the deploy recreated Quickwit itself: the web container `depends_on` it,
  and `docker compose up -d openbesluitvorming …` recreates a dependency
  whose image changed. "The deploy does not restart Quickwit" holds for a
  changed `quickwit.yaml` (a mounted file), not for a changed tag. Take the
  metastore copy *before* merging the tag change, not after;
- the 0.9 image has no `curl`, so every `docker exec … curl` in the monitor
  became a silent no-op. It now reaches Quickwit from the host by container
  IP;
- 0.9 renamed the cache metrics: one family per measure with a
  `component_name` label (`searcher_split`, `fd`, `fastfields`, …) instead
  of a family per cache. The monitor and the collector filter follow;
- `/api/search` takes `query`, not `q`, and an empty query without an
  organization answers an empty list by design. A baseline taken with the
  wrong parameter name looks exactly like an outage after the upgrade.

**2. Stop the churn on v3b.** `PUT /api/v1/indexes/woozi-events-v3b` with
`commit_timeout_secs: 60`. Check: the index config reports 60; over the next
hour the number of published splits stops climbing between merges. This alone
removes most of what the split cache machinery exists for, and it holds even
if the reindex is postponed.

Done 2026-09-02 11:57 UTC, after a one-week import of `maassluis` on 0.9
succeeded end to end (run `5e885f68`, 3 meetings, row visible in v3b).

**3. Make room on the volume.** Lower
`QUICKWIT_SPLIT_CACHE_MAX_NUM_BYTES` to 40G for the duration and restart
Quickwit, so v3b keeps a warm working set while v4 grows next to it. Bind-mount
a second directory of the same volume into the container as the future index
path:

```yaml
- /mnt/quickwit-cache/indexes/woozi-events-v4:/quickwit/qwdata/indexes-prod/woozi-events-v4
```

Check: `df` shows at least 100 GB free on the volume after the cache settles.

**4. Create v4 by pointing only the workers at it.**

```sh
# /opt/woozi/.env
WORKER_QUICKWIT_INDEX_ID=woozi-events-v4
WORKER_PROJECTION_VERSION=search-v4-local
WORKER_QUICKWIT_INDEX_URI=file:///quickwit/qwdata/indexes-prod/woozi-events-v4
WORKER_QUICKWIT_COMMIT_TIMEOUT_SECS=60
QUICKWIT_INGEST_COMMIT=auto
```

Restart the workers. Check, before any reindex is queued:
`GET /api/v1/indexes/woozi-events-v4` shows the `file://` URI and timeout 60,
and `du` on the bind-mounted directory starts moving with the first daily
import. If the URI is wrong, delete the index now; it is empty.

**5. Reindex one source, then all.** `reindex_only` on `dongen` first, as the
2026-08-28 trial did, and compare meeting counts with the export log. Then
every source, with the same worker count as the v3b campaign (four workers,
eight jobs). Last time: 10.4 hours for 5.28M documents. Watch: volume free
space, ingest 413s in the worker logs, and the shape of the split count (it
should climb slowly and merge down, not sawtooth by the second).

**6. Verify v4.** Rows per entity type against the table above minus the
duplicate share; per-source meeting counts against the export log for a
sample of ten sources; the three Dongen meetings from #203 showing one row
each with the corrected date; a phrase query, a date range, a date sort.

**7. Cut over the reader.** `QUICKWIT_INDEX_ID=woozi-events-v4` and
`WOOZI_PROJECTION_VERSION=search-v4-local` on the web container, restart it.
That is the only moment users notice anything. Check: `/api/search` latency
at or below step 0, the monitor's index follows automatically.

**8. Delete what the local index makes irrelevant.** One pull request:

- `searcher.split_cache` section out of `quickwit.yaml`; the split-cache
  environment out of the compose file; the `/mnt/quickwit-cache` bind mount
  over `searcher-split-cache` out;
- the split-cache block out of `monitor-production.sh`: the phantom check,
  the purge, the cooldown, the orphan report, the cold-cache check, and all
  `WOOZI_MONITOR_QUICKWIT_SPLIT_CACHE_*` and `QUICKWIT_CACHE_COLD_PERCENT`
  settings;
- the six Quickwit split-cache series out of the collector config, and the
  `/mnt/quickwit-cache` mountpoint entry stays (it now holds the index);
- the AGENTS.md paragraphs about never deleting from the split cache, reduced
  to one line saying the index is local and why.

Restart Quickwit once more with the cache section gone. Check: the cache
directory stays empty across a day of searches.

**9. Retire v3b.** Keep it a week. Then `DELETE /api/v1/indexes/woozi-events-v3b`
and remove its S3 prefix. The v3b metastore copy from step 0 stays on the host
like the prod one does.

## What can go wrong

- **The volume fills during the campaign.** v3b cache at 40G plus v4 at 60G
  plus merge headroom is near 147G. Mitigation: step 3's check, and the
  campaign can pause (the queue is durable) while the cache budget drops
  further; v3b keeps serving from S3 at cold-cache speed.
- **Ingest V2 throughput.** V2 paces per shard; whether the campaign hits that
  ceiling is not known until step 5's single-source run. If it is much slower
  than v3b's campaign, `commit=force` per batch is not the answer (that is
  churn again); more shards or a larger batch are.
- **Something on the 0.9 read path differs.** Step 1's check is a full pass
  of the search test suite against production, not one query.
