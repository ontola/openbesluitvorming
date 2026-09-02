# AGENTS.md

This repo (working name "woozi") is the active rewrite of Open Raadsinformatie,
served at https://openbesluitvorming.nl.

## Stack

- Deno backend for extraction, search API, admin API, and production serving
- Vite + Svelte + TypeScript frontend for the public UI and admin UI
- Quickwit for search projection
- S3-compatible storage for original files and derived text
- SQLite for prototype run-state storage

Key directories:

- [`src/`](src)
- [`web/`](web)
- [`tests/`](tests)
- [`quickwit/`](quickwit)
- [`schemas/`](schemas)
- [`services/extraction/`](services/extraction) — stateless PDF extraction microservice (FastAPI + pymupdf4llm)
- [`infra/`](infra) — OpenTofu infrastructure definitions for Hetzner Cloud

## Architecture

The intended flow is:

```text
source system
  -> extractor / poller
  -> canonical entity
  -> entity.commit event
  -> projections:
       - Quickwit (search)
       - export changes log (SQLite buffer + NDJSON segments in S3,
         served via /api/export/snapshot and /api/export/changes)
```

Important rules:

- Quickwit is a projection, not the source of truth.
- Original files are stored in S3-compatible object storage.
- Derived document markdown is stored in object storage.
- The export changes log (`src/exports/log.ts`) deduplicates commits on
  `content_hash` and assigns per-source monotonic sequence numbers **via a
  single shared SQLite file**. Workers on a second host would silently corrupt
  the sequence — scale workers on one host only until that is redesigned.
- Blocklisted documents (`document_blocklist` in the ops store, e.g. BSN
  takedowns) are checked before the S3 cache shortcut and centrally in
  `executeIngest.onEntity`; no ingest path may bypass those checks. See the
  internal takedown runbook in `docs_internal/` (gitignored).
- The HTTP surface (search, admin API, document preview, admin UI) is served by the `openbesluitvorming` container (`web/server.ts`). Import execution runs in a separate `worker` container (`src/worker.ts`) so long-running ingests don't compete with search for the single-threaded Deno event loop.
- PDF extraction is offloaded to remote extraction workers. The ingest worker never holds PDF bytes in memory when `WOOZI_EXTRACTION_SERVICE_URL` is set.
- Shared browser/backend types belong in [`src/types.ts`](src/types.ts).

Current implemented slices:

- Notubiz, iBabs (165 sources, date-range chunked), GemeenteOplossingen, and
  Parlaeus meetings and documents (production)
- document download and caching
- markdown extraction with `transmutation` + remote extraction workers
- PDF page-chunk derivation
- Quickwit indexing
- export API for bulk harvesting/sync (snapshot + changes feed, see API.md)
- BSN detection during ingest (detect-only by default) + document blocklist
  with a takedown script (`scripts/delete_document.ts`)
- public search UI
- admin UI for imports and reruns

## Best Practices

### General

- Keep vocabulary and entity shapes consistent; do not invent a parallel naming scheme casually.
- Prefer explicit pipeline levels such as full import, rederive from cache, and reindex, rather than hidden cache behavior.
- `reindex_only` is implemented (`src/pipeline/reindex.ts`): it re-projects a source from the export log, never from the supplier APIs, and rehydrates document text from object storage. It replays what was imported once — it cannot produce a newly added entity type or field, which still needs a real import. `retry_failed_documents` is still unimplemented and throws.
- **`reindex_only` against a *live* index appends rows, it does not replace them.** Quickwit is append-only, and `toCommitEvent` reuses the export log's original `record.time`, so the re-projected row carries the *same* `time` as the row it was meant to supersede. `dedupeLatestIndexedHits` only replaces on a strictly newer `time`, so a tie is won by whichever row Quickwit happens to return first — the stale one about half the time. Measured 2026-08-31 after reindexing one source: every meeting had 2 rows, one `time`, and two `start_date` values two hours apart; the corrected value was in the index and search kept showing the old one. The 2026-08-12 corpus reindex worked because it targeted a *new, empty* index (the v2→v3 projection bump), not because reindex replaces anything. So a projection-wide data fix needs a projection-version bump into a fresh index — reindexing in place doubles the index and leaves the outcome to chance.
- Treat Quickwit index changes as projection-versioned changes, not mutable source-of-truth edits.

### Frontend

- Use Svelte + TypeScript in [`web/src/`](web/src).
- Keep the public UI and admin UI visually consistent.
- Shared UI patterns should use generic primitives rather than one-off page-local button classes.
- Result detail uses a full-screen overlay reader rather than a separate page.

### Search

- Search result shaping belongs in [`web/search_api.ts`](web/search_api.ts), not in the browser.
- Prefer grouped document-level results even when the underlying search unit is a PDF page chunk.
- Keep projection versioning explicit so rebuilds do not leak duplicate results into search.
- **Ordering and date filtering must be pushed down to Quickwit, never applied only app-side.** The scan window is capped (`max_hits`), so sorting the fetched rows can at best reorder the wrong ones: the index's `timestamp_field` is `time` (the ingest time), so an unsorted scan returns whatever was imported last. That was issue #184 — results ordered by import date. Sorting and range filtering need a mapped **fast field**; a dynamic field silently ignores both.
- A mapped `datetime` field that fails to parse makes Quickwit **discard the entire document**, with a successful-looking ingest response. Normalize dates through `toIndexDateTime` (`src/quickwit/project.ts`) and let bad values fall back to `undefined` — one unsorted row beats an entity that is missing from search.
- Quickwit's `sort_by` direction is the opposite of the usual convention: bare field name = descending, `-` prefix = ascending. Missing values sort last either way.
- `sort=relevance` is the absence of `sort_by`: Quickwit's own score order, and the one ordering that needs no mapped fast field. `sortResults` must leave that order alone — the rows arrive ranked and are collected into an insertion-ordered Map.
- `/api/search` refuses what it cannot honour rather than answering a different question: unknown `entityType`, `organization` or `sort`, a `dateFrom`/`dateTo` that is not a bare `YYYY-MM-DD` calendar date, and the unsupported proximity notation `"a b"~10` all return 400 from `web/search_params.ts`. A silent substitution is harder for a consumer to notice than an error (#196, #199, #223, #224).
- Every public error response carries a stable `code` from `web/api_errors.ts` beside its Dutch `error` sentence. The sentence is free to be reworded or translated; the code is the public contract a consumer matches on, so renaming one is a breaking change. `tests/api_errors.test.ts` pins the list and checks that API.md documents each of them. Admin endpoints are deliberately outside this.

### Extraction and documents

- Original downloaded files must be stored in S3-compatible storage.
- Full-document markdown should remain available in one detail request.
- PDF page chunks are optional derived artifacts for search/navigation, not a replacement for full markdown.
- PDF extraction is limited to 40 pages per document (`MAX_PDF_PAGES` in `src/documents/text.ts`).
- PDF extraction can be offloaded to remote workers via `WOOZI_EXTRACTION_SERVICE_URL` (comma-separated list of URLs). The ingest worker round-robins requests across workers and falls back to local pymupdf4llm subprocess when no URL is configured.
- The extraction service (`services/extraction/`) is a stateless FastAPI wrapper around pymupdf4llm. It accepts a source URL via `POST /extract` and returns markdown; the extractor itself downloads the PDF so the ingest worker never holds PDF bytes.
- The extraction service **requires S3 credentials** (it uploads extracted markdown itself). Without them every `/extract` returns 422 "Unable to locate credentials" — this silently broke all extraction in July 2026. Provisioning via `infra/` injects them into `/root/extraction-s3.env` on the worker hosts; keep that in sync with the `S3_*` values in `/opt/woozi/.env`.
- Cache invalidation is still partly source-specific; preserve comments where behavior is Notubiz-specific and needs later generalization.

### Outbound HTTP from the ingest worker

- **Every `fetch()` in the ingest path must have an explicit `AbortSignal.timeout(...)`**. Observed failure mode: a remote server (iBabs, Notubiz, extraction workers, Quickwit) holds a TCP connection open without responding, and the worker hangs forever on that slot — seen in production blocking 7 of 8 slots for 10+ hours. All ingest-path fetches now cap at 90-180s with retries on TimeoutError/AbortError.
- Prefer "fail a slot fast" over "retry indefinitely". For the extraction service, one attempt with a 180s cap is better than 2+ attempts with the same cap, because the second attempt only doubles the slot-block time when the source PDF is genuinely slow.
- When a fetch is retryable, try a _different_ backend on retry (e.g. round-robin to the next extraction worker) so we don't hammer a slow/dead node.

### Operations and state

- Current admin/run state is SQLite-backed for the prototype.
- Treat SQLite as pragmatic prototype state, not the final metadata-store design.
- Store enough run metadata to distinguish user-triggered, scheduled, full, cache-rederived, and later reindex-only executions.
- Startup reconciliation requeues previously `running` imports (interrupted by
  a restart, usually a deploy) instead of failing them, capped at two requeues
  per run via `interrupted_count`. Queued imports all resume simultaneously.
  High concurrency settings (`INGEST_CONCURRENCY` > 8 combined with
  `WOOZI_DOCUMENT_CONCURRENCY` > 10) can saturate the event loop with outbound
  HTTP connections.
- The import worker is expected to run permanently: `deploy-production.sh` defaults
  `WORKER_REPLICAS` to 1 and the production monitor alerts when it is missing.
  (It used to default to 0, which silently froze all imports for 11 days in
  July 2026.)
- Production monitoring (`scripts/monitor-production.sh`, the deployed bash
  variant — the .ts variant is a local tool) checks search latency, disk,
  containers, import health (stalled pipeline, stuck queue, extraction failure
  surges), and backup freshness. Runs every 2 min via `woozi-monitor.timer`.
- The monitor must watch the index the app actually serves. Its split-cache sweep classifies every cached split absent from `QUICKWIT_INDEX_ID`'s metastore as an orphan — and until 2026-09-01 it deleted them, so pointing it at the wrong index did not degrade a check, it deleted the live cache. That is what happened between 2026-08-12 and 2026-08-30: the monitor's own default still said `woozi-events-prod` after the projection moved to `woozi-events-v3b`, so 53G of cache sat on a frozen index nobody queries while every live split was removed within two minutes of being fetched. It now follows `QUICKWIT_INDEX_ID` from the same `.env` the app reads. Bump the projection index and the monitor follows; override only via `WOOZI_MONITOR_QUICKWIT_INDEX_ID`.
- **Never delete from Quickwit's split-cache directory while Quickwit runs.** It is Quickwit's own directory and it keeps its own tally of what it holds; unlinking a file does not correct that tally, and Quickwit stops downloading at its byte budget whether or not those bytes still exist. The monitor's "non-disruptive orphan sweep" did exactly this from 2026-07-18 onward: measured 2026-09-01, Quickwit reported 1196 splits and 119.5G against a 120G budget with 7 splits on disk, and had stopped filling the cache entirely. The sweep now only counts and reports; the one safe way to clear the cache is the stop/wipe/start path, because the tally is rebuilt on startup. That path's only trigger is the tally drifting from the disk by more than `QUICKWIT_SPLIT_CACHE_PHANTOM_GB` — not a file ratio: with an honest tally Quickwit's LRU evicts superseded splits before live ones, so a high orphan ratio is the cache at rest. The purge wipes whatever `docker inspect` reports as the mount source of the cache path; the real cache is a bind mount over `/mnt/quickwit-cache`, and a hard-coded wipe of the docker volume hit an empty stub for weeks.
- The SQLite state (ops + export log) is backed up daily to S3 via
  `woozi-backup.timer` running `scripts/backup_state.ts` inside the web
  container (14-day retention, `backups/sqlite/` prefix). Install with
  `scripts/install-production-backup.sh`.
- A source revalidation sweep runs daily via `woozi-revalidate.timer`
  (`scripts/revalidate_documents.ts`, one run per calibrated supplier —
  currently iBabs and Notubiz): checks whether documents we still serve have
  actually been removed at the source (HTTP status only, no re-download), so
  a source-side deletion eventually surfaces without a manual takedown
  report. Confirmed-gone documents (3+ consecutive daily misses, tracked in
  `document_revalidation`/`revalidation_cursor` in the ops SQLite) are only
  reported, never auto-deleted — review and delete via
  `scripts/delete_document.ts`. Install with
  `scripts/install-production-revalidate.sh`. See
  `docs_internal/bsn-takedown.md` ("Stap 6") for the per-supplier
  "genuinely gone" calibration and the org-wide-outage-vs-real-deletion
  distinction.
- The admin dashboard polls every 5s. Any per-run work it does (e.g. fetching run detail) multiplies by the number of visible runs — keep the dashboard cheap so it doesn't starve the single-threaded `openbesluitvorming` process and slow down user searches.

### iBabs specifics

- iBabs is IPv4-whitelisted. Only the production server (`91.98.32.151`) can reach `wcf.ibabs.eu`. Local machines and Hetzner extraction workers cannot. `src/ibabs/client.ts` calls `dns.setDefaultResultOrder("ipv4first")` at module load so calls to `wcf.ibabs.eu` resolve to the whitelisted IPv4 address. Do not break this.
- iBabs returns all meetings for a date range in a single SOAP response. Large multi-year ranges are chunked into 6-month windows (`WOOZI_IBABS_DATE_CHUNK_MONTHS`) before each SOAP call. Don't widen chunks without testing — the XML blob can grow enough to time out server-side or OOM the parser.
- iBabs ingest uses the same `WOOZI_DOCUMENT_CONCURRENCY` as Notubiz.
- **iBabs rate limits are per IP address, and the whole fleet shares one.** Their figures, given on 2026-08-17: **180/min** for `wcf.ibabs.eu` and the public portal, **30/min** for `publicdownload` and the document viewer. Downloads are the tighter budget by six times, so they have their own limiter (`ibabsDownloadRateLimiter`); the breaker behind both is shared, because a 403 on either host is the same address being told to stop. Pacing divides the budget by `WOOZI_IBABS_WORKERS` (wired to the replica count in compose) and keeps a fifth in hand — with four workers that is 144/min and 24/min fleet-wide. Do not raise these to "catch up" after an outage: exceeding them does not cost a 429, it cost twelve days of blacklisting from 2026-08-05, which took every iBabs source down and blocked recovery of a separate data gap (#205, #220).

#### Reaching iBabs from local for exploration

The client supports routing through an HTTP/SOCKS proxy via `IBABS_PROXY_URL` (applies to both SOAP calls and `downloadDocument`). To exercise the live API from a local machine without waiting for a deploy:

```sh
ssh -i ~/.ssh/woozi_beta_deploy_ed25519 -D 1080 -N -f root@91.98.32.151
export IBABS_PROXY_URL=socks5://localhost:1080
```

The WSDL is reachable through the proxy at `https://wcf.ibabs.eu/api/Public.svc?wsdl`; input/output shapes are split across `?xsd=xsd0` … `?xsd=xsd13`. Use this when adding a new SOAP operation — don't guess parameter names from a previous test report.

Do not commit production code that depends on the proxy being set; production runs on the whitelisted worker without it.

#### Public API operations actually wired up

`src/ibabs/client.ts` implements `GetMeetingtypes`, `GetMeetingsByDateRange`, `GetLists`, `GetListsEntriesByFilterRequest`, `GetListEntry`, `GetListEntryVotesByListEntryId`, and `downloadDocument` — the last four are what motions and per-member votes are built on. The WSDL exposes ~28 operations; still unwired are `GetMeetingsChangedSince` (delta sync), `GetUsers` / `GetUserVotes`, and `Search`. Several require authenticated (username/password) access on top of the IP whitelist — verify behavior before adding a method.

Do not trust an `ERR` from one operation as evidence that a whole area is closed off: `GetListEntryVotes` is denied, but `GetListEntryVotesByListEntryId` returns the same per-member vote data publicly, and it takes an `<EntryId>` parameter despite the operation name (`<ListEntryId>` yields a misleading `System.Guid` cast error). See `docs/ibabs-import-plan.md`, "Per-member votes are public after all".

Quickest way to probe: read-only `curl -4` SOAP calls over SSH on `woozi-1` itself. That gets the whitelisted IPv4 source address without a SOCKS tunnel — and Deno is not installed on the host, only inside the containers, so probe scripts written in Deno need `docker exec` or a rewrite.

### Worker CPU ceiling

- The worker is a single Deno process = one vCPU. On a 4-vCPU host that's a 25% utilization ceiling. Atomic run claiming (`claimQueuedRun` in `src/ops/store.ts`, `UPDATE ... WHERE status='queued' RETURNING`) already exists, so multiple `worker` containers **on the same host** can safely share the queue: `docker compose up -d --scale worker=N worker`. Do not put workers on a second host — the export changes log and blocklist assume one shared SQLite file (see Architecture). `INGEST_CONCURRENCY` above 8 within one worker doesn't help — it just contends for the same core.

## Development Commands

Run these from the repo root.

### Install

```sh
pnpm i
```

### Frontend dev with HMR

```sh
pnpm run dev
```

This starts:

- backend container on `http://127.0.0.1:8787`
- Vite dev server on `http://127.0.0.1:4317`

Override the Vite port if needed:

```sh
WOOZI_WEB_PORT=4401 pnpm run dev:web
```

### Production-style local serving

```sh
pnpm run web
```

### Local stack

External S3-compatible storage:

```sh
docker compose up -d
```

Local MinIO for development/tests:

```sh
docker compose --profile local-s3 up -d
```

### Ingest example

```sh
pnpm run ingest:haarlem
```

## Testing

Preferred verification path:

```sh
pnpm run lint
pnpm run check-format
pnpm run build:web
deno test --no-run -A
```

Focused tests:

```sh
pnpm run test:quickwit
pnpm run test:gui
pnpm run test:e2e
```

What they cover:

- `test:e2e`
  - extractor-level end-to-end coverage for live Notubiz behavior
- `test:quickwit`
  - projection + Quickwit indexing/search validation
- `test:gui`
  - GUI-driven import/search flow validation

If you change search shaping, result rendering, or snippet behavior, `test:quickwit` and `test:gui` are the most relevant.

## Common Gotchas

- `web/dist/` is generated output and should not be edited by hand.
- `.env` in `woozi/` is ignored and should contain S3 credentials/config.
- Some extractor tests and flows depend on live upstream behavior and can fail due to source instability.
- PDF extraction should use the Rust `transmutation` CLI.
- Encrypted PDFs and malformed PDFs should surface as clear document-level extraction issues.
- Quickwit deletes are expensive; prefer projection versioning and rebuilds over delete-heavy maintenance.
- `Herleid uit cache` currently reuses stored source files, but still may depend on upstream meeting enumeration unless the source manifests are fully replayable.

## Doc Updates

If architecture, workflow, or product direction changes, update:

- [`README.md`](README.md)
- [`API.md`](API.md) — the public API contract
- [`deployment.md`](deployment.md) — production deploy and operations
- [`docs/migration-guide.md`](docs/migration-guide.md) — when public API changes affect ORI Classic migrators

`docs_internal/` (gitignored) holds sensitive working notes — takedown
runbooks, usage research containing personal data. Never move its contents
into tracked docs.

Keep these aligned with the actual working prototype, not just the target architecture.
