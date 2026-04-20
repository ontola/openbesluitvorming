# AGENTS.md

`woozi/` is the active rewrite prototype for Open Raadsinformatie and should be treated as its own repo.

## Stack

- Deno backend for extraction, search API, admin API, and production serving
- Vite + Svelte + TypeScript frontend for the public UI and admin UI
- Quickwit for search projection
- S3-compatible storage for original files and derived text
- SQLite for prototype run-state storage

Key directories:

- [`src/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/src)
- [`web/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/web)
- [`tests/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/tests)
- [`quickwit/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/quickwit)
- [`schemas/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/schemas)
- [`services/extraction/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/services/extraction) — stateless PDF extraction microservice (FastAPI + pymupdf4llm)
- [`infra/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/infra) — OpenTofu infrastructure definitions for Hetzner Cloud

## Architecture

The intended flow is:

```text
source system
  -> extractor / poller
  -> canonical entity
  -> entity.commit event
  -> projection
  -> Quickwit
```

Important rules:

- Quickwit is a projection, not the source of truth.
- Original files are stored in S3-compatible object storage.
- Derived document markdown is stored in object storage.
- The HTTP surface (search, admin API, document preview, admin UI) is served by the `openbesluitvorming` container (`web/server.ts`). Import execution runs in a separate `worker` container (`src/worker.ts`) so long-running ingests don't compete with search for the single-threaded Deno event loop.
- PDF extraction is offloaded to remote extraction workers. The ingest worker never holds PDF bytes in memory when `WOOZI_EXTRACTION_SERVICE_URL` is set.
- Shared browser/backend types belong in [`src/types.ts`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/src/types.ts).

Current implemented slices:

- Notubiz meetings and documents (production)
- iBabs meetings and documents (production; 165 sources in catalog, date-range chunked)
- document download and caching
- markdown extraction with `transmutation` + remote extraction workers
- PDF page-chunk derivation
- Quickwit indexing
- public search UI
- admin UI for imports and reruns

## Best Practices

### General

- Keep vocabulary and entity shapes consistent; do not invent a parallel naming scheme casually.
- Prefer explicit pipeline levels such as full import, rederive from cache, and reindex, rather than hidden cache behavior.
- Treat Quickwit index changes as projection-versioned changes, not mutable source-of-truth edits.

### Frontend

- Use Svelte + TypeScript in [`web/src/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/web/src).
- Keep the public UI and admin UI visually consistent.
- Shared UI patterns should use generic primitives rather than one-off page-local button classes.
- Result detail uses a full-screen overlay reader rather than a separate page.

### Search

- Search result shaping belongs in [`web/search_api.ts`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/web/search_api.ts), not in the browser.
- Prefer grouped document-level results even when the underlying search unit is a PDF page chunk.
- Keep projection versioning explicit so rebuilds do not leak duplicate results into search.

### Extraction and documents

- Original downloaded files must be stored in S3-compatible storage.
- Full-document markdown should remain available in one detail request.
- PDF page chunks are optional derived artifacts for search/navigation, not a replacement for full markdown.
- PDF extraction is limited to 40 pages per document (`MAX_PDF_PAGES` in `src/documents/text.ts`).
- PDF extraction can be offloaded to remote workers via `WOOZI_EXTRACTION_SERVICE_URL` (comma-separated list of URLs). The ingest worker round-robins requests across workers and falls back to local pymupdf4llm subprocess when no URL is configured.
- The extraction service (`services/extraction/`) is a stateless FastAPI wrapper around pymupdf4llm. It accepts a source URL via `POST /extract` and returns markdown; the extractor itself downloads the PDF so the ingest worker never holds PDF bytes.
- Cache invalidation is still partly source-specific; preserve comments where behavior is Notubiz-specific and needs later generalization.

### Outbound HTTP from the ingest worker

- **Every `fetch()` in the ingest path must have an explicit `AbortSignal.timeout(...)`**. Observed failure mode: a remote server (iBabs, Notubiz, extraction workers, Quickwit) holds a TCP connection open without responding, and the worker hangs forever on that slot — seen in production blocking 7 of 8 slots for 10+ hours. All ingest-path fetches now cap at 90-180s with retries on TimeoutError/AbortError.
- Prefer "fail a slot fast" over "retry indefinitely". For the extraction service, one attempt with a 180s cap is better than 2+ attempts with the same cap, because the second attempt only doubles the slot-block time when the source PDF is genuinely slow.
- When a fetch is retryable, try a _different_ backend on retry (e.g. round-robin to the next extraction worker) so we don't hammer a slow/dead node.

### Operations and state

- Current admin/run state is SQLite-backed for the prototype.
- Treat SQLite as pragmatic prototype state, not the final metadata-store design.
- Store enough run metadata to distinguish user-triggered, scheduled, full, cache-rederived, and later reindex-only executions.
- Beware of queued imports resuming on restart: reconciliation marks previously `running` imports as `failed` on startup, but `queued` imports all resume simultaneously. High concurrency settings (`INGEST_CONCURRENCY` > 8 combined with `WOOZI_DOCUMENT_CONCURRENCY` > 10) can saturate the event loop with outbound HTTP connections.
- The admin dashboard polls every 5s. Any per-run work it does (e.g. fetching run detail) multiplies by the number of visible runs — keep the dashboard cheap so it doesn't starve the single-threaded `openbesluitvorming` process and slow down user searches.

### iBabs specifics

- iBabs is IPv4-whitelisted. `src/ibabs/client.ts` calls `dns.setDefaultResultOrder("ipv4first")` at module load so calls to `wcf.ibabs.eu` resolve to the whitelisted IPv4 address. Do not break this.
- iBabs returns all meetings for a date range in a single SOAP response. Large multi-year ranges are chunked into 6-month windows (`WOOZI_IBABS_DATE_CHUNK_MONTHS`) before each SOAP call. Don't widen chunks without testing — the XML blob can grow enough to time out server-side or OOM the parser.
- iBabs ingest uses the same `WOOZI_DOCUMENT_CONCURRENCY` as Notubiz.

### Worker CPU ceiling

- The worker is a single Deno process = one vCPU. On a 4-vCPU host that's a 25% utilization ceiling. Path forward when this bites: run multiple `worker` containers against the same SQLite queue, which requires atomic claim (`UPDATE ... WHERE status='queued' RETURNING *`) in `src/ops/store.ts` to avoid two workers executing the same run. Until that lands, `INGEST_CONCURRENCY` above 8 doesn't help — it just contends for the same core.

## Development Commands

Run these from [`woozi/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi).

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

- [`README.md`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/README.md)
- [`../scratchpad/2026-03-31-WISHES.md`](/Users/joep/dev/github/openstate/open-raadsinformatie/scratchpad/2026-03-31-WISHES.md)
- [`../scratchpad/2026-03-31-REWRITE_PLAN.md`](/Users/joep/dev/github/openstate/open-raadsinformatie/scratchpad/2026-03-31-REWRITE_PLAN.md)

Keep these aligned with the actual working prototype, not just the target architecture.
