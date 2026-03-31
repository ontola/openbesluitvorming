# Woozi

Woozi stands for Wet Open Overheid Zoek Index.
It aims to index all public NL government documents.
It also serves as a next-gen replacement of Open-Raadsinformatie.

This folder contains new rewrite-oriented assets that are grounded in the
existing ORI codebase.

The first step is a minimal schema package based on current model and
transformer output, not a full redesign of the domain model.

## Running locally

```sh
pnpm i
pnpm test
docker compose up -d
```

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
- extract plain text from PDFs and office files
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
- derived text or markdown

### 6. Metadata Store

Woozi still uses a small metadata store.

PostgreSQL remains useful for:

- source cursors
- latest entity head per ID
- content hashes
- commit metadata
- projector checkpoints
- resolver mappings

PostgreSQL should be small and boring in Woozi.
It is not the document store and not the search index.

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
- `entity.commit` events for canonical meetings and documents
- attachment download into S3-compatible object storage
- plain-text extraction for PDF and Word-style documents
- a local Quickwit setup and projection client
- live e2e coverage that ingests Haarlem meetings and attached files into Quickwit and the GUI

## Commands

From [`woozi/`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi):

- `pnpm run web`
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
- extracts plain text from those files
- emits `entity.commit` events for `Meeting` and `Document`
- projects both entity types into Quickwit

To start the frontend prototype:

```bash
docker compose up -d --build openbesluitvorming
```

## Local extractor requirements

The host-side ingest command currently uses local text extraction tools:

- `pdftotext` for PDFs
- `textutil` for `.doc`, `.docx`, `.rtf`, `.odt`, and HTML-like office documents

On this machine, those are available at:

- `/opt/homebrew/bin/pdftotext`
- `/usr/bin/textutil`
