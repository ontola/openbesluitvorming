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
- Search and admin APIs are served by the Deno backend.
- Shared browser/backend types belong in [`src/types.ts`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/src/types.ts).

Current implemented slices:

- Notubiz meetings and documents
- iBabs ingestion foundations
- document download and caching
- markdown extraction with `transmutation`
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
- Cache invalidation is still partly source-specific; preserve comments where behavior is Notubiz-specific and needs later generalization.

### Operations and state

- Current admin/run state is SQLite-backed for the prototype.
- Treat SQLite as pragmatic prototype state, not the final metadata-store design.
- Store enough run metadata to distinguish user-triggered, scheduled, full, cache-rederived, and later reindex-only executions.

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
