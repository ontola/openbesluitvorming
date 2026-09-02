# Handover: split cache, the monitor, and the next index

Written 2026-09-02, for whoever picks this up next. It covers one connected
thread of work: why search was slow for weeks, what was changed, what is still
broken, and which of the claims below are measured rather than reasoned.

Read [`search-performance-quickwit-s3.md`](search-performance-quickwit-s3.md)
first for the July analysis; this document is what happened after it.

## Current production state (2026-09-02, ~08:15 UTC)

Search is healthy. Users are not affected by anything described here.

```
/api/search           0.39-0.43s, HTTP 200
slow-search alerts    10 in 12h   (was 115 in the week before 2026-08-29)
```

Quickwit's split cache, after the sweep stopped deleting:

```
tally    475 splits, 65.2 GB      (quickwit_cache_searcher_split_* metrics)
disk      61 GB, 475 files        (/dev/sdb on /mnt/quickwit-cache, 147G, 79G free)
fds       26                      (was pinned at 100, all on deleted files)
```

Tally and disk agree again, which they had not since mid-August.

The index being served:

```
woozi-events-v3b   s3://woozi-dev/indexes-prod/woozi-events-v3b
                   commit_timeout_secs: 1
                   22-26 published splits, 62.4 GB, 5.21M documents
```

`woozi-events-prod` was deleted on 2026-08-31 after verifying zero real queries
against it. Its metastore is kept at
`/root/woozi-events-prod-metastore-2026-08-31.json` on the host.

## The chain of faults

Each was found while fixing the previous one. That order matters: the later
ones were invisible until the earlier ones were out of the way.

**1. The monitor watched an index nobody served.** `monitor-production.sh`
resolved its index from `WOOZI_MONITOR_QUICKWIT_INDEX_ID`, which nothing ever
set, falling back to a literal `woozi-events-prod` — while the app had moved to
`woozi-events-v3b` on 2026-08-12. Its split-cache janitor deletes every cached
file absent from that index's metastore, so it protected 92 splits of a frozen
index and treated every live split as an orphan. Measured 2026-08-30 in a quiet
period: 50 of 50 cached splits belonged to prod, 0 to v3b. Fixed in `c09fcfc`
(PR #240): the monitor now follows `QUICKWIT_INDEX_ID` from the same `.env` the
app reads.

**2. Deleting from that directory was never safe.** The sweep called itself
non-disruptive because Linux permits unlinking an open file. True of the file
handle, false of everything else: the split cache is Quickwit's directory and it
keeps its own tally, which an external unlink never corrects. Measured
2026-09-01, after six weeks of sweeping and two weeks of process uptime — three
views of one fault:

```
tally         1196 splits, 119.5 GB   against a 120 GB budget
disk             7 splits, 56 MB
descriptors    93 of 100 pointing at deleted files
volume         df 42 GB used, du 56 MB
```

Believing itself full, Quickwit had stopped downloading; search ran off S3.
All three clear only on restart. Fixed in `89235d5` (PR #243): the sweep counts
and reports, and a `quickwit_split_cache_phantom` check compares the tally
against the disk.

**3. The escalation fired constantly and did not purge.** Fixed in the
commit that follows this document (see "What was broken" below, and the
deploy note at the end of it).

## What was broken, and the fix

Both faults below were fixed in one change, because fixing either alone
would have been worse than the pair: a working purge under the ratio trigger
would have wiped a warm 61 GB cache every cooldown.

The fix makes the phantom gap — Quickwit's tally minus the bytes on disk —
the *only* trigger for the stop/wipe/start path, and makes that path wipe
the directory Docker reports as the mount source of the cache path instead of
a hard-coded volume. The ratio is still computed and logged as
`quickwit_split_cache_orphans`, but nothing acts on it.

Why the phantom gap and not a byte-pressure condition: a full cache is the
healthy state, so "bytes against budget" cannot distinguish healthy from
broken. What the restart actually repairs is a tally Quickwit cannot correct
itself, and that is exactly the phantom gap. Once the tally is honest,
Quickwit's own LRU evicts superseded splits before live ones — every query
touches every live split, superseded splits are never touched again — so
orphans piling up is what this cache looks like at rest. Dry run against
production on 2026-09-02 with the real values (tally 65.2 GB, disk 65.2 GB,
475 files, 449 orphans): no purge at the 20 GB threshold; the escalation
branch fires with the threshold forced to 1 GB and resolves the mount to
`/mnt/quickwit-cache`.

**Deploy note.** `/opt/woozi/.env` on the host still carries
`WOOZI_MONITOR_QUICKWIT_SPLIT_CACHE_HEAL_COOLDOWN_SECONDS=86400` from the
holding measure. Remove that line once this change is deployed; the default
of 1800 is correct again because a purge empties the gap that triggered it.
The backup of the previous `.env` is at `/opt/woozi/.env.bak-2026-09-02`.

### The purge wiped the wrong directory

`quickwit_split_cache_full_restart()` does:

```sh
docker run --rm -v woozi_quickwit-data:/qw alpine \
  sh -c 'rm -rf /qw/searcher-split-cache && mkdir -p /qw/searcher-split-cache'
```

That path inside the docker volume is an empty stub (4.0K, verified). The real
cache is a bind mount: `/mnt/quickwit-cache` on `/dev/sdb`, mounted over the
same path inside the container. So "purged and restarted" has only ever
restarted. This predates the work above; it dates from when the cache was moved
to its own disk.

The giveaway is in the alerts: `cache_files=475` is byte-identical in every one
of them. A working purge would have moved that number.

Fixed: the purge now asks `docker inspect` for the mount source of that path
and empties *that*, refusing (with a `quickwit_split_cache_purge_skipped`
alert) rather than guessing when no mount is found.

### The ratio trigger did not measure pollution

The escalation fires on `cache_files / published_splits >= 3`. With the sweep no
longer deleting, orphans accumulate normally: 475 files against 26 published is
a ratio of 18, permanently. That produced a Quickwit restart roughly every 45
minutes — 16 in 12 hours on 2026-09-02.

This is the third time this script has tied a threshold to a number that does
not track what it claims to measure; the first two are described in its own
comments (the `MIN_FILES` floor, and the cold-cache percentage). Worth treating
as a pattern rather than three coincidences.

**Damped first, then fixed.** `/opt/woozi/.env` was given
`WOOZI_MONITOR_QUICKWIT_SPLIT_CACHE_HEAL_COOLDOWN_SECONDS=86400` on 2026-09-02
as a holding measure (one restart a day instead of sixteen). The code fix
removed the ratio trigger and the `MIN_FILES` floor altogether; see the deploy
note above for removing the holding measure.

## The next index is one operation, not three

Three separate things want a fresh index and they are the same operation. This
is written up in
[`search-performance-quickwit-s3.md`](search-performance-quickwit-s3.md) (PR
#244, open at time of writing):

1. **The #203 timezone backlog.** Supplier timestamps before 2026-08-28 were
   stamped `Z` on a Dutch wall clock. The projection reads them correctly since
   `a887778`, but re-projecting into the *live* index appends a second row per
   entity carrying the same `time`, and `dedupeLatestIndexedHits` replaces only
   on a strictly newer `time` — so the tie goes to whichever row Quickwit
   returns first. Verified on three Dongen meetings: 2 rows each, one distinct
   `time`, two `start_date` values two hours apart. Reindexing in place doubles
   the index and settles each date by chance.
2. **Layer 1 of the July prevention plan.** Local `index_uri`,
   `commit_timeout_secs` of 60-120 (creation-time only on Quickwit 0.8). This
   makes the split cache — and everything in this document — irrelevant.
3. **The projection compaction** from Option C, estimated at a ~3.5x shrink.

It fits: 147 GB dedicated volume with 79 GB free, 104 GB free on root, against a
62.4 GB index.

Cost, measured from the 2026-08-12 migration: **10.4 hours** for 314 sources and
5.28M documents, with 4 workers. That run had 4 failures, all
`Quickwit ingest failed 413`, fixed since in `9d62339`.

Doing this also clears the duplicate rows the 2026-08-28 trial reindex left in
`dongen`.

## Claims in this thread that turned out wrong

Listed so the next reader calibrates rather than trusts.

- *"Quickwit evicts superseded splits itself once its tally is honest"* — stated
  in the `89235d5` commit message. 475 cached files against 26 published splits
  contradicts it. Whatever Quickwit does with superseded splits, it is not
  prompt enough to keep the ratio near 1.
- *"The cache never downloads"* — said on 2026-08-31 after watching an empty
  cache for an hour. It does download; it was being deleted, and later blocked
  by the phantom tally. The hour was too short a window to conclude from.
- The monitor's `MIN_FILES` floor and the cold-cache percentage were both
  documented in-script as having failed the same way. Any new threshold here
  should be argued against the mechanism, not fitted to a recent measurement.

## What to check first

In this order, because each answers whether the next one is still true:

1. `df -h /mnt/quickwit-cache` against `du -sh` on the same path. A large gap
   means something is unlinking files under Quickwit again.
2. The `quickwit_cache_searcher_split_in_cache_num_bytes` metric against that
   disk figure. Divergence is the phantom-tally fault returning.
3. `journalctl -u woozi-monitor | grep "purged and restarted"` — after the
   fix this should be rare and each one should coincide with a phantom gap;
   a restart with `phantom_gb` near zero means the trigger is misreading.
4. Whether PR #245 landed. It adds `/mnt/quickwit-cache` to the collector's
   filesystem scraper and scrapes six Quickwit split-cache metrics into SigNoz.
   Both blind spots above were invisible for six weeks because neither was
   collected.

## Open pull requests at time of writing

- **#244** — the July document updated with the above, and the argument that the
  three reindexes are one operation.
- **#245** — collector sees the cache disk and Quickwit's own metrics.

Merged and live: #240 (right index), #243 (sweep stops deleting), #242
(`robots.txt`, `llms.txt`).
