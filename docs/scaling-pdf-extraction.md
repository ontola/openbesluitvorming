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

## Back-of-Envelope Math

Current throughput (observed): ~200 municipalities × 3 months in 5 days.

That's roughly:
- ~40 municipalities per day per server
- ~200 municipalities / 40 per day = 5 days

To hit 1 day: need 5× throughput → 5 servers (Option C) or equivalent CPU via Option A/B.

To hit same-day for a full year of 350 municipalities:
- ~4× more data than current 3-month/200-muni run
- Need ~20× throughput → 20 extraction replicas (Option A) or 4 large servers (Option C)
