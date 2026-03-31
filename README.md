# Woozi

Woozi stands for Wet Open Overheid Zoek Index.
It aims to index all public NL government documents.
It also serves as a next-gen replacement of Open-Raadsinformatie.

This folder contains new rewrite-oriented assets that are grounded in the
existing ORI codebase.

The first step is a minimal schema package based on current model and
transformer output, not a full redesign of the domain model.

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
- a live e2e test for one day of Haarlem meetings

The next step is to add the first event contract:

- `entity.commit`
