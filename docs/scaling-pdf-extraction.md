# Scaling PDF Extraction

## Problem

Importing 3 months of data from ~200 municipalities takes about 5 days on a single Hetzner `cpx32` (4 vCPU, 8 GB RAM). The goal is to bring this down to 1 day or less.

The bottleneck is `pymupdf4llm` — a Python subprocess that converts each PDF to structured markdown with page chunks. It's CPU-bound and takes seconds per document. With `WOOZI_DOCUMENT_CONCURRENCY=3` and `INGEST_CONCURRENCY=4`, a single server processes roughly 12 PDFs at once. That's not enough for millions of documents.

pymupdf4llm is necessary — it produces the best quality markdown from Dutch government PDFs. We can't replace it, so we need to run more of them in parallel.

## Current Architecture

```
┌─────────────────────────────────────┐
│  woozi-1 (cpx32, 4 vCPU, 8 GB)     │
│                                     │
│  ingest server                      │
│    → fetch meetings from API        │
│    → download PDF                   │
│    → spawn pymupdf4llm subprocess   │  ← bottleneck
│    → store markdown in S3           │
│    → index in Quickwit              │
│                                     │
│  SQLite (run tracking)              │
│  Quickwit (search index)            │
└─────────────────────────────────────┘
```

Each PDF extraction spawns a local Python subprocess. Concurrency is limited by CPU cores and memory on this one machine.

## Options

### Option A: Extraction Microservice (Recommended)

Turn `pymupdf4llm` into a small stateless HTTP service. Run N replicas behind a load balancer. The ingest server remains the single orchestrator — one admin panel, one SQLite, one place to manage everything.

```
┌──────────────────────────────────┐       ┌────────────────────────────┐
│  ingest server (woozi-1, cpx32)  │       │  pymupdf4llm service       │
│                                  │       │  (N replicas, any size)    │
│  admin panel ◄── single UI       │       │                            │
│  SQLite (run tracking)           │  HTTP │  POST /extract             │
│  Quickwit (search index)         │       │    accepts: PDF bytes      │
│                                  │       │    returns: markdown+pages  │
│  fetch meetings                  │       │                            │
│  download PDF ───────────────────┼──────>│  stateless, no disk, no DB │
│  receive markdown <──────────────┼───────│  no admin, no tracking     │
│  store in S3                     │       │  just CPU work             │
│  index in Quickwit               │       │                            │
└──────────────────────────────────┘       └────────────────────────────┘
```

**What changes:**
- New: small Python HTTP server wrapping pymupdf4llm (~30 lines of FastAPI)
- New: Docker image for the extraction service (Python + pymupdf4llm)
- Change: `extractPdfWithPymupdf4llmCli()` in `text.ts` makes an HTTP POST instead of spawning a subprocess
- The ingest server's `WOOZI_DOCUMENT_CONCURRENCY` controls how many concurrent HTTP calls it makes

**What stays the same:**
- Single admin panel on the ingest server — all runs, issues, and progress in one place
- No changes to SQLite, Quickwit, S3, or the ingest pipeline structure
- Caching in S3 works exactly as before
- The ingest server still orchestrates everything

**Scaling:**
- 5 replicas on `cpx32` (4 vCPU each) = 20 cores doing PDF extraction
- Expected: 5 days → ~1 day
- Can scale to 10+ replicas if needed
- Each replica is stateless, no coordination needed

**Cost estimate (Hetzner):**
- 5× `cpx32` at ~€28/month each = ~€140/month
- Or use `cpx22` (3 vCPU, €15/month) = ~€75/month for 5 replicas
- Only run during import, spin down after → a few euros per import run

**Pros:**
- Single admin panel — all runs visible in one place
- Minimal code changes to existing pipeline
- Linear scaling: more replicas = proportionally faster
- Can spin up/down on demand (only pay during imports)
- Each service is simple, stateless, easy to debug

**Cons:**
- Network overhead for PDF transfer (mitigated: PDFs are already in memory)
- New service to maintain (but it's ~30 lines)
- Ingest server becomes the bottleneck if it can't dispatch fast enough (unlikely — it's mostly waiting on extraction workers)

### Option B: Bigger Server

Just use a larger Hetzner machine with more vCPU and bump concurrency.

**What changes:**
- Upgrade from `cpx32` (4 vCPU) to `ccx63` (48 vCPU, dedicated) or similar
- Set `WOOZI_DOCUMENT_CONCURRENCY=20` and `INGEST_CONCURRENCY=8`

**Scaling:**
- 48 cores vs 4 = roughly 10× more concurrent extractions
- Expected: 5 days → ~0.5 days
- Single machine, no architecture changes

**Cost estimate (Hetzner):**
- `ccx63` (48 vCPU, 192 GB): ~€300/month
- Or `ccx53` (32 vCPU, 128 GB): ~€200/month
- Can resize temporarily for import runs

**Pros:**
- Zero code changes — just change env vars and server type
- No new services to deploy or maintain
- Simplest possible approach

**Cons:**
- Vertical scaling has hard limits (max ~96 vCPU on Hetzner)
- Memory contention: pymupdf4llm + large PDFs can spike memory usage
- Single point of failure during imports
- Paying for a big server even when idle (unless you resize)

### Option C: Multiple Full Ingest Servers

Run multiple copies of the entire ingest server, each handling different sources or date ranges.

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  woozi-1             │  │  woozi-2             │  │  woozi-3             │
│  sources: A-G        │  │  sources: H-N        │  │  sources: O-Z        │
│  own SQLite          │  │  own SQLite          │  │  own SQLite          │
│  shared Quickwit     │  │  shared Quickwit     │  │  shared Quickwit     │
│  shared S3           │  │  shared S3           │  │  shared S3           │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

**What changes:**
- Partition sources across N servers (e.g., by municipality letter range or source key)
- Each server runs the full pipeline independently
- Quickwit and S3 are shared (they handle concurrent writes fine)
- SQLite stays local per server (each tracks its own runs)

**Scaling:**
- 3 servers = ~3× faster (roughly 5 days → 1.7 days)
- 5 servers = ~5× faster (roughly 5 days → 1 day)
- Linear scaling up to the number of sources

**Cost estimate:**
- 3× `cpx32` at ~€28/month each = ~€84/month
- 5× `cpx32` = ~€140/month

**Pros:**
- No code changes at all — just deploy the same image multiple times with different source configs
- Each server is fully independent, no coordination needed
- Can use the admin UI on each server to monitor progress
- S3 cache deduplication still works

**Cons:**
- **No single admin panel** — each server has its own SQLite, its own admin UI. You'd need to check N dashboards to see overall progress. Fixing this requires replacing SQLite with shared PostgreSQL, which is a significant change.
- Operational overhead: managing N servers instead of 1
- Source partitioning is manual (decide which server handles which municipalities)
- Quickwit needs to handle concurrent indexing from N servers (should be fine)

### Option C+: Multiple Servers with Shared PostgreSQL

Same as Option C, but replace SQLite with a shared PostgreSQL instance so all servers report to one admin panel.

**Additional changes vs Option C:**
- Replace `node:sqlite` `DatabaseSync` in `src/ops/store.ts` with a PostgreSQL client (e.g. `postgres` npm package or Deno's `deno-postgres`)
- Migrate the schema (2 tables: `ingest_run`, `ingest_run_issue` — straightforward)
- Add a managed PostgreSQL instance (Hetzner, Supabase, Neon, etc.)
- One server serves the admin panel, all servers write to the same DB

**Cost estimate:**
- Hetzner managed Postgres: ~€10/month (smallest tier)
- Or Neon/Supabase free tier (likely sufficient for run tracking)

**Pros:**
- Single admin panel across all servers
- All the benefits of Option C

**Cons:**
- Moderate code change (replace SQLite adapter with Postgres)
- New managed service dependency
- Need to handle concurrent write safety (Postgres handles this natively, unlike SQLite)

## Recommendation

**Option A** (extraction microservice) is the best fit because:

1. **Single admin panel** — one ingest server, one SQLite, one dashboard. No Postgres migration needed.
2. **Scales the bottleneck directly** — only the slow part (pymupdf4llm) gets distributed. Everything else stays on one machine.
3. **Simple workers** — the extraction service is ~30 lines of Python, stateless, no config. Easy to deploy and scale.
4. **Flexible** — bump `WOOZI_DOCUMENT_CONCURRENCY` on the ingest server to send more work to the pool. Scale replicas up/down independently.

Option B (bigger server) is the fastest to try — zero code changes, just resize the VM and bump env vars. Good for a quick 5-10× improvement. Start here if you want results today.

Option C/C+ (multiple full servers) works but splits the admin panel unless you also migrate to PostgreSQL, which is a bigger change than building the extraction microservice.

## Infrastructure as Code

All infrastructure should be defined in code, not provisioned manually via `hcloud` CLI or the Hetzner console.

### Tooling: OpenTofu + Hetzner Provider

[OpenTofu](https://opentofu.org/) (open-source Terraform fork) with the [`hetznercloud/hcloud`](https://registry.terraform.io/providers/hetznercloud/hcloud/latest) provider. Lives in a `infra/` directory in this repo.

Manages:
- Hetzner Cloud servers (ingest server, extraction workers)
- Private network between servers
- SSH keys
- Firewall rules
- DNS records (if moved from Netlify to Hetzner DNS)

### What this looks like for Option A

```
infra/
├── main.tf              # provider config, backend
├── network.tf           # private network for ingest ↔ workers
├── servers.tf           # ingest server + extraction workers
├── variables.tf         # replica count, server types, etc.
├── outputs.tf           # IPs, connection strings
└── cloud-init/
    ├── ingest.yaml      # cloud-init for ingest server (docker compose up)
    └── worker.yaml      # cloud-init for extraction workers
```

Key variables:
```hcl
variable "extraction_worker_count" {
  default = 5
  description = "Number of pymupdf4llm extraction workers"
}

variable "extraction_worker_type" {
  default = "cpx22"
  description = "Hetzner server type for extraction workers"
}
```

Scaling up = change `extraction_worker_count` and `tofu apply`. Scaling down after import = set to `0` and `tofu apply`.

### Service Definitions: Docker Compose

The extraction workers run a single Docker container each. The ingest server runs the existing Compose stack (app + Quickwit + Caddy). Both use published images from GHCR.

The extraction service image gets its own Dockerfile and publish workflow, similar to `Dockerfile.web`.

### Private Networking

Extraction workers should be on a Hetzner private network (`10.0.0.0/16`) — not exposed to the internet. The ingest server reaches them via private IP. No TLS needed on the internal network.

Service discovery: either a simple list of worker IPs passed as env var, or a lightweight load balancer (HAProxy/Caddy on the ingest server).

### CI/CD Integration

The existing GitHub Actions workflow (`publish-openbesluitvorming.yml`) can be extended:
1. Build + publish the extraction service image alongside the app image
2. Optionally trigger `tofu apply` to update running infrastructure

### State Management

OpenTofu state stored in Hetzner Object Storage (S3-compatible, already in use for document cache):
```hcl
terraform {
  backend "s3" {
    bucket   = "woozi-tfstate"
    key      = "infra/terraform.tfstate"
    endpoint = "fsn1.your-objectstorage.com"
    region   = "fsn1"
  }
}
```

## Observed Performance (2026-04-09)

Tested on production (`cpx32`, 4 vCPU, 8 GB) with remote extraction workers (`cpx22`, 2 vCPU each).

| Import scope | Workers | INGEST_CONCURRENCY | Duration |
|---|---|---|---|
| 1 day, all sources | 3× cpx22 | 20 | ~1 min |
| 1 month, all sources | 3× cpx22 | 20 | ~2 min |
| 1 year, all sources | 10× cpx22 | 12 | ~40 min |
| Original baseline (no workers) | 0 | 4 | ~5 days for 3 months |

Key findings:
- The primary bottleneck is **Notubiz API pagination**, not PDF extraction
- `INGEST_CONCURRENCY` is the main throughput lever
- `INGEST_CONCURRENCY=20` is unstable on cpx32 (connection drops under sustained load)
- `INGEST_CONCURRENCY=12` is the stable max on cpx32
- `INGEST_MEMORY_PER_JOB_MB` must be set to ~200 when using remote extraction, otherwise the memory limiter silently caps concurrency
- Extraction workers are well-utilized for year-long imports (~50-100% CPU) but overkill for shorter periods
- For daily imports of recent data (~7 days), local subprocess is fast enough — no workers needed

### OOM crashes with local extraction (2026-04-10)

Running overnight with `INGEST_CONCURRENCY=12` and **local** pymupdf4llm (no remote workers), the container was OOM-killed **10 times**. The kernel `dmesg` log showed:

- `python3` (pymupdf4llm) using **6.1 GB RSS** on a single PDF
- `deno` process using **3.2 GB RSS** from accumulated concurrent import state
- Total server RAM: 8 GB, shared with Quickwit + Caddy

Each OOM kill triggers a container restart, which runs `reconcileInterruptedRuns` and marks all in-progress imports as `"Process terminated before completion"` with step `ingest_quickwit`. This is **not** a Quickwit failure — it's the reconciliation labeling.

**Root cause — two separate memory issues:**

1. **Deno process accumulating memory (8 out of 10 OOM kills):** With `INGEST_CONCURRENCY=12`, the Deno process holds meeting data, document metadata, S3 connections, and Quickwit batches for 12 concurrent imports. This accumulates to 3+ GB on the 8 GB server.

2. **pymupdf4llm spiking on large PDFs (2 out of 10 OOM kills):** A single pymupdf4llm subprocess used 6.1 GB RSS processing one PDF. Even with `MAX_PDF_PAGES=40`, complex pages can spike memory.

**Fixes:**

- **Remote extraction** fixes issue #2 (pymupdf4llm spikes). The memory spike happens on the disposable worker instead of the ingest server.
- **Lower `INGEST_CONCURRENCY`** or **set `DENO_V8_FLAGS=--max-old-space-size=4096`** to address issue #1 (Deno heap growth). A V8 heap cap causes a JS exception instead of an OOM kill, allowing the process to recover gracefully.
- **A bigger ingest server** (e.g. cpx42 with 16 GB RAM) gives more headroom for concurrent imports without changing concurrency settings.

**Conclusion:** Remote extraction is required for stability, but on its own it only prevents the pymupdf4llm OOM spikes. The Deno heap growth from high concurrency is a separate issue that needs either a memory cap, lower concurrency, or a bigger server.

## Planned: Auto-scaling and Scheduled Imports

### Daily scheduled imports (no workers needed)

For ongoing daily imports, a cron trigger is sufficient. The local pymupdf4llm subprocess handles a few days of data in under a minute.

Implementation:
1. Add a cron job (either on the ingest server or as a GitHub Action schedule) that calls `POST /api/admin/rerun` with a rolling 7-day date range
2. No extraction workers needed — `WOOZI_EXTRACTION_SERVICE_URL` stays empty, falls back to local subprocess
3. Runs daily at a quiet hour (e.g. 03:00 UTC)

### Auto-scaling for manual large imports

When a user manually triggers a large import (e.g. backfill a full year), extraction workers should spin up automatically and tear down when the import finishes.

#### Design

```
User starts large import via admin panel
  → ingest server detects large job (queued count > threshold)
  → calls Hetzner Cloud API to create extraction server(s)
  → waits for health check to pass
  → updates its own WOOZI_EXTRACTION_SERVICE_URL at runtime (no restart needed)
  → import runs with remote extraction
  → periodic check: if queued + running = 0 for 10 minutes
  → calls Hetzner API to delete extraction server(s)
  → clears WOOZI_EXTRACTION_SERVICE_URL
```

#### Requirements

- `HCLOUD_TOKEN` in the ingest server's environment
- Extraction service image must be public on GHCR (already done)
- Firewall rules must allow port 8000 from the ingest server (already configured in Tofu)

#### Implementation steps

1. **Add a Hetzner Cloud client** to the ingest server (`src/infra/hcloud.ts` or similar):
   - `createExtractionServer(serverType, image)` → returns IP
   - `deleteExtractionServer(serverId)`
   - `listExtractionServers()` → returns running extraction servers

2. **Add auto-scale logic** to `src/ingest.ts`:
   - On import queue start: if queued > 10 and no extraction URL configured, call `createExtractionServer()`
   - Store the server ID in memory (or SQLite) for teardown
   - After creation, wait for `/health` to respond, then set `WOOZI_EXTRACTION_SERVICE_URL` in-process (no env file, no restart)
   - The `nextExtractionServiceUrl()` function in `text.ts` already reads the URL list dynamically

3. **Add idle teardown** to the polling loop:
   - When `runningCount + queuedCount === 0` for 10 minutes, delete extraction servers and clear the URL

4. **Add admin UI controls** (optional):
   - "Start extractors" / "Stop extractors" buttons in the admin panel as manual override
   - Show current auto-scale state (idle, scaling up, active, cooling down)

#### What stays manual

- Backfill imports: user decides when to start from the admin panel
- The system auto-provisions compute, but the user initiates the import
- Tofu remains for initial infrastructure setup (firewalls, SSH keys), but runtime scaling bypasses it

#### Cost model

- Daily imports: €0 extra (local subprocess)
- Manual large import: one cpx22 for the duration (~€0.01/hr), auto-deleted when done
- Full backfill: 10× cpx22 for ~1 hour (~€0.10 total)

## Planned: Split Web Server and Import Worker

### Problem

Currently one Deno process handles both serving search queries and running imports. During imports, the process consumes all available CPU and memory, making the search UI slow or unresponsive for users. This was observed repeatedly during backfill runs — load averages above 14 on a 4 vCPU server, 5+ GB memory usage, and sluggish page loads.

### Design

Split the single `openbesluitvorming` container into two:

```
┌──────────────────────────────┐    ┌──────────────────────────────┐
│  web (always running)        │    │  worker (always running)     │
│                              │    │                              │
│  search UI + API             │    │  import pipeline             │
│  admin panel                 │    │  reads queue from SQLite/DB  │
│  entity detail API           │    │  talks to extraction workers │
│  PDF page rendering          │    │  writes to Quickwit + S3     │
│  source listing              │    │                              │
│  serves static assets        │    │  no HTTP server needed       │
│                              │    │  (or minimal admin API)      │
│  lightweight, fast           │    │  heavy, can use all CPU      │
└──────────────────────────────┘    └──────────────────────────────┘
        │                                     │
        └──── shared Quickwit + S3 ───────────┘
```

### Why this matters

- **User experience**: search stays fast during imports
- **Memory isolation**: import worker OOM doesn't take down search
- **Independent scaling**: worker can run on a bigger/separate machine
- **Simpler operations**: restart worker without affecting users

### Implementation approach

1. **Extract the import loop** from `web/server.ts` into a standalone entrypoint (e.g. `src/worker.ts`) that:
   - Reads queued imports from SQLite
   - Runs the extraction pipeline
   - Writes to Quickwit and S3
   - Exits when queue is empty (or runs as a long-lived process)

2. **The admin panel** stays on the web server. It writes import requests to SQLite. The worker polls SQLite for new work. This is the existing pattern — just split across two processes.

3. **SQLite sharing**: both processes access the same SQLite file (on a shared volume). SQLite supports concurrent readers with one writer, which fits this model — the web server mostly reads (admin panel), the worker mostly writes (import progress).

4. **Docker Compose**: add a second service using the same image but a different entrypoint:
   ```yaml
   worker:
     image: ${OPENBESLUITVORMING_IMAGE}
     command: ["run", "-A", "src/worker.ts"]
     volumes:
       - woozi-state:/data
     environment:
       # same S3, Quickwit, extraction service config
   ```

5. **Resource limits**: the web container gets a memory limit (e.g. 1 GB) and the worker gets the rest. If the worker OOMs, it restarts without affecting search.

### What changes for users

Nothing — same admin panel, same search UI, same URLs. Imports just don't slow down search anymore.

### Priority

This should be done after the extraction service architecture stabilizes. The current setup works for periodic imports. The split becomes important when:
- Multiple users rely on the search UI during business hours
- Imports need to run during peak traffic
- The server needs to handle both search traffic and large backfills simultaneously
