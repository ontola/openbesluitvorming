# Woozi

Woozi stands for Wet Open Overheid Zoek Index.
It aims to index all public NL government documents.
It also serves as a next-gen replacement of Open-Raadsinformatie.

This folder contains new rewrite-oriented assets that are grounded in the
existing ORI codebase.

The first step is a minimal schema package based on current model and
transformer output, not a full redesign of the domain model.

The current implementation is split into:

- a Deno backend for extraction, search APIs, admin APIs, and production serving
- a Vite + TypeScript frontend for the public UI and admin UI
- shared TypeScript contracts in [`src/types.ts`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/src/types.ts)

## Use the API

See [API.md](./API.md)

## Running locally

```sh
docker compose up -d
# visit http://0.0.0.0:8787
```

For frontend iteration with HMR, use one command:

```sh
pnpm run dev
```

That does two things:

- starts the Docker backend services needed for app development: `quickwit` and `openbesluitvorming`
- starts the Vite HMR frontend on the host

That gives you:

- the Docker backend on `http://127.0.0.1:8787`
- the Vite dev server with HMR on `http://127.0.0.1:4317`

Vite proxies `/api/*` calls to the Docker backend, so reruns and extraction use
the same environment as the containerized app, including the installed `transmutation`
binary.
Open `http://127.0.0.1:4317` while iterating on the frontend.

Object storage is taken from your environment configuration. If your `.env` points
to external S3-compatible storage such as Hetzner, `pnpm run dev` uses that directly
and does not start local MinIO.

Important:

- `pnpm run dev` is the intended development entrypoint
- `pnpm run dev` starts Docker-backed services and the API, then runs Vite with HMR
- `pnpm run dev` clears stale listeners on the HMR port before starting, so leftover Vite processes do not usually require manual cleanup

If you only want the infra:

```sh
pnpm run dev:infra
```

Run:

```sh
pnpm run dev
```

To stop the Docker side again:

```sh
pnpm run dev:down
```

If you want a different dev port:

```sh
WOOZI_WEB_PORT=4401 pnpm run dev:web
```

If you want a different HMR web port:

```sh
WOOZI_WEB_PORT=4401 pnpm run dev
```

## Production with Caddy

The repo includes a production-oriented compose file and Caddy config:

- [docker-compose.production.yml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/docker-compose.production.yml)
- [Caddyfile](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/Caddyfile)

That setup is intended for:

- `openbesluitvorming`
- `quickwit`
- `caddy`

with external S3-compatible object storage from `.env`.

Preferred beta deploy flow:

```sh
git push origin main
```

That triggers the GitHub Actions workflow in [.github/workflows/publish-openbesluitvorming.yml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/.github/workflows/publish-openbesluitvorming.yml), which builds and publishes:

- `ghcr.io/openstate/woozi-openbesluitvorming:main`
- `ghcr.io/openstate/woozi-openbesluitvorming:sha-<git-sha>`
- `ghcr.io/openstate/woozi-openbesluitvorming:latest`

Then update beta to the exact current commit image:

```sh
pnpm run deploy:beta
```

`deploy:beta` now does one thing: over SSH, it tells the server to pull `ghcr.io/openstate/woozi-openbesluitvorming:sha-<short-git-sha>` and restart the app container.

Before it deploys, it checks the running server for active imports and refuses to restart the app if any imports are still `running`.

To override that safety check:

```sh
FORCE=1 pnpm run deploy:beta
```

By default, `deploy:beta` derives the GHCR owner from your `origin` remote. If you need to override it explicitly:

```sh
IMAGE_REPOSITORY=ghcr.io/your-org/woozi-openbesluitvorming pnpm run deploy:beta
```

When production infra files change, sync those separately:

```sh
pnpm run deploy:beta:infra
```

That is only for runtime config such as:

- [docker-compose.production.yml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/docker-compose.production.yml)
- [Caddyfile](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/Caddyfile)
- [quickwit/quickwit.yaml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/quickwit/quickwit.yaml)

Required production env includes:

- `DOMAIN`
- `ADMIN_PASSWORD_HASH`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_STORAGE_BUCKET_NAME`
- `S3_STORAGE_ENDPOINT`
- `S3_STORAGE_REGION`
- `QUICKWIT_INDEX_ID`
- `QUICKWIT_CLUSTER_ID`
- `QUICKWIT_NODE_ID`
- `QUICKWIT_INDEX_ROOT_PREFIX`

The server should run production with:

```sh
docker compose -f docker-compose.production.yml up -d
```

Point your domain to the server first so Caddy can obtain Let's Encrypt certificates.

Important:

- the GHCR package must be public, or the server must be logged in to GHCR
- code deploys should update container images, not rsync source files

Quickwit defaults are intentionally different between local and production so both environments do not accidentally share the same S3-backed metastore and index:

- local/dev defaults:
  - `QUICKWIT_CLUSTER_ID=woozi-dev`
  - `QUICKWIT_NODE_ID=quickwit-dev`
  - `QUICKWIT_INDEX_ROOT_PREFIX=indexes-dev`
  - `QUICKWIT_INDEX_ID=woozi-events-dev`
- production defaults:
  - `QUICKWIT_CLUSTER_ID=woozi-prod`
  - `QUICKWIT_NODE_ID=quickwit-prod`
  - `QUICKWIT_INDEX_ROOT_PREFIX=indexes-prod`
  - `QUICKWIT_INDEX_ID=woozi-events-prod`

Important:

- if production previously used `indexes` + `woozi-events`, switching to `indexes-prod` + `woozi-events-prod` creates a fresh search projection
- after that change, production search needs a reindex/reimport before results appear again

## Architecture

Woozi is designed as an event-driven indexing system.

The core split is:

- extract data from source systems
- normalize it into canonical entities
- emit events only for changes
- build read projections from those events

The main flow is:

```text
source system
  -> extractor / poller
  -> canonical entity
  -> event broker
  -> projection services
  -> search index / resolver / other read models
```

## Main Components

### 1. Extractors

Extractors talk to source systems such as Notubiz, iBabs, GO, and Parlaeus.

Responsibilities:

- poll for changes in a date range or from a source cursor
- fetch raw payloads and documents
- store retrieved files in S3-compatible object storage
- extract markdown-ready document text from PDFs and office files
- normalize source-specific structures
- produce canonical entities

The current ORI extractor logic is the starting point for this layer.

### 2. Canonical Entities

The system does not index raw source payloads directly.

Instead, each source payload is transformed into a canonical entity such as:

- `Meeting`
- `Document`
- `Committee`
- `Vote`

The schemas in [`schemas/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/schemas) are the first version of those contracts.

### 3. Change Detection

Quickwit is not used to determine whether something changed.

Change detection happens before indexing:

- each canonical entity gets a stable ID
- each canonical payload gets a content hash
- the latest known hash is compared against metadata storage
- if nothing changed, no event is emitted
- if something changed, a new commit event is emitted

Edits are modeled as new versions, not in-place mutations.
Deletes are modeled as tombstones or delete commits.

### 4. Event Broker

When an entity changes, Woozi emits an event into an event broker.

The expected event model is:

- CloudEvents envelope
- `entity.commit` payload

This broker decouples extraction from indexing and makes replay possible.

### 5. Canonical Storage

The canonical representation should not live in Quickwit.

Canonical JSON and original files should be stored in object storage, such as:

- S3
- MinIO

Example object classes:

- raw source payloads
- canonical JSON snapshots
- original files
- derived markdown and search text

### 6. Metadata Store

Woozi still needs a small metadata store.

PostgreSQL remains useful for:

- source cursors
- latest entity head per ID
- content hashes
- commit metadata
- projector checkpoints
- resolver mappings

PostgreSQL should be small and boring in Woozi.
It is not the document store and not the search index.

Current prototype note:

- extraction/admin run state is currently stored in a local SQLite file
- that is an implementation shortcut for the prototype, not the intended final metadata design

### 7. Projection Services

Projection services consume events and build read models.

Initial projections:

- search projection
- document resolver projection
- admin/reporting projection

Each projection can be rebuilt by replaying events and canonical snapshots.

### 8. Quickwit

Quickwit is the search projection, not the source of truth.

Responsibilities:

- store search-ready projected documents
- support search and filtering at large scale
- stay cheap by relying on object storage-backed indexing

Quickwit should receive projection documents derived from canonical entities.
It should not receive raw source payloads and should not be the place where updates are detected.

## Design Rules

- Raw source payloads are not the public contract.
- Canonical entities are the internal contract.
- Events describe changes to canonical entities.
- Quickwit is a projection.
- Object storage holds canonical payloads and files.
- PostgreSQL holds metadata and coordination state.

## Current State

This folder currently contains:

- minimal entity schemas
- a first Deno-based Notubiz extractor slice
- a Vite + TypeScript frontend with HMR for the public UI and admin UI
- shared frontend/backend TypeScript API types
- `entity.commit` events for canonical meetings and documents
- attachment download into S3-compatible object storage
- markdown extraction for PDF and Word-style documents
- a local Quickwit setup and projection client
- a small admin UI for reruns and extraction run inspection
- live e2e coverage that ingests Haarlem meetings and attached files into Quickwit and the GUI

## Commands

From [`woozi/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi):

- `pnpm run dev`
- `pnpm run dev:infra`
- `pnpm run dev:docker`
- `pnpm run dev:down`
- `pnpm run dev:web`
- `pnpm run web`
- `pnpm run serve:web`
- `pnpm run build:web`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm test:gui`
- `pnpm test:quickwit`
- `pnpm run extract:haarlem`
- `pnpm run ingest:haarlem`
- `pnpm run lint`
- `pnpm run format`
- `pnpm run check-format`

Quickwit helpers live in [`quickwit/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/quickwit).

For real S3-compatible storage, put these values in [`.env.example`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/.env.example) copied to `.env`:

- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_STORAGE_BUCKET_NAME`
- `S3_STORAGE_ENDPOINT`
- `S3_STORAGE_REGION`

To run against external S3-compatible storage:

```bash
docker compose up -d
```

To run the local stack with MinIO for development and tests:

```bash
docker compose --profile local-s3 up -d
```

To extract one Haarlem day and ingest the resulting commit events into Quickwit:

```bash
pnpm run ingest:haarlem
```

That command now:

- extracts public Haarlem meetings from Notubiz
- downloads attached source files
- stores the originals in S3-compatible object storage
- extracts markdown from those files and serves it lazily in the detail view
- emits `entity.commit` events for `Meeting` and `Document`
- projects both entity types into Quickwit

To start the frontend prototype:

```bash
docker compose up -d --build openbesluitvorming
```

For local production-style serving without Docker:

```bash
pnpm run web
```

## Local extractor requirements

The host-side ingest command currently uses:

- the Rust `transmutation` CLI for PDFs
- direct text decoding for `.txt`, `.md`, `.json`, and HTML-like documents
- office formats like `.doc`, `.docx`, `.rtf`, and `.odt` are not supported yet and are logged as extraction warnings

In Docker and compose, the `transmutation` CLI is installed in the image automatically.
On the host, Woozi will try to call `transmutation` from `PATH` or from `WOOZI_TRANSMUTATION_BIN`.

For Apple Silicon macOS, you can install it like this:

```sh
cargo install --locked transmutation
```

If the CLI is missing, PDF extraction fails explicitly and the import records an extraction issue.

There is no remaining host-only Office extractor in the runtime anymore. Unsupported office
formats are currently skipped with an explicit extraction warning.
