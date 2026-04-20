# Deployment

This file documents the current deployment approach for `woozi/`.

It should be kept aligned with the real working setup, not an aspirational target.

## Current Shape

The app runs as four containers on the main host plus N stateless extraction workers on separate Hetzner Cloud VMs:

- `openbesluitvorming` — HTTP surface (`web/server.ts`): search API, admin API, document preview, admin UI
- `worker` — import executor (`src/worker.ts`): polls SQLite for queued runs, runs extraction, writes to Quickwit + S3
- `quickwit` — search index
- `caddy` — reverse proxy + TLS
- `extraction` workers (1..N remote hosts, `services/extraction/`) — stateless PDF extraction microservice

The HTTP container and the import worker use the **same image** with different entrypoints, sharing a named volume for SQLite state.

Object storage is external (Hetzner Object Storage in the current setup), configured via `.env`.

Vite is development-only and is not part of the production runtime.

## Local Dev

The intended local development entrypoint is:

```sh
pnpm run dev
```

This does:

- start Docker-backed services for `quickwit` and `openbesluitvorming`
- run local Vite with HMR on the host

That gives:

- backend API on `http://127.0.0.1:8787`
- frontend HMR on `http://127.0.0.1:4317`

Important:

- local MinIO is not part of the default dev flow anymore
- `.env` should contain the real S3-compatible storage configuration
- if `.env` points at Hetzner Object Storage, the app uses that directly

## Required Environment

The backend reads configuration from `.env` via [`src/config.ts`](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/src/config.ts).

Required S3-compatible storage values:

- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_STORAGE_BUCKET_NAME`
- `S3_STORAGE_ENDPOINT`
- `S3_STORAGE_REGION`

Common app/runtime values:

- `PORT`
- `QUICKWIT_URL`
- `QUICKWIT_INDEX_ID`
- `QUICKWIT_CLUSTER_ID`
- `QUICKWIT_NODE_ID`
- `QUICKWIT_INDEX_ROOT_PREFIX`
- `QUICKWIT_FAST_FIELD_CACHE_CAPACITY`
- `QUICKWIT_SPLIT_FOOTER_CACHE_CAPACITY`
- `QUICKWIT_PARTIAL_REQUEST_CACHE_CAPACITY`
- `QUICKWIT_SPLIT_CACHE_MAX_NUM_BYTES`
- `QUICKWIT_SPLIT_CACHE_MAX_NUM_SPLITS`
- `QUICKWIT_SPLIT_CACHE_NUM_CONCURRENT_DOWNLOADS`
- `WOOZI_KV_PATH`
- `INGEST_CONCURRENCY`
- `INGEST_MEMORY_PER_JOB_MB`
- `INGEST_MIN_FREE_MEMORY_MB`
- `QUICKWIT_BATCH_SIZE`

## Docker Runtime

The production image is built from [Dockerfile.web](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/Dockerfile.web).

It:

- builds the frontend with Node/Vite
- runs the backend with Deno
- installs `transmutation` in the image for document extraction

The backend entrypoint is:

```sh
deno run -A web/server.ts
```

## Deployment Model

Routine production deploys are now image-based.

The server should be treated as runtime state only, not as a source checkout.

That means:

- application code should arrive via published container images
- the live server should not be treated as a Git worktree
- the live server should not be used as the normal place to build app images from source
- the only repo-managed files expected on the server are runtime config files such as Compose, Caddy, and Quickwit config

The current flow is:

1. push a commit to `main`
2. GitHub Actions builds and publishes the app image to GHCR
3. the server pulls the selected image and restarts the app service

The workflow lives in:

- [publish-openbesluitvorming.yml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/.github/workflows/publish-openbesluitvorming.yml)
- [deploy-beta.yml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/.github/workflows/deploy-beta.yml)

The published image repository currently follows the GitHub repo owner. In the current setup that means:

- `ghcr.io/ontola/woozi-openbesluitvorming:main`
- `ghcr.io/ontola/woozi-openbesluitvorming:sha-<short-git-sha>`
- `ghcr.io/ontola/woozi-openbesluitvorming:latest`

If the package owner changes, treat the repository path as configurable rather than hardcoded.

### Normal Deploy

The current setup now supports automatic beta deployment after a successful image publish on `main`.

The `deploy-beta.yml` workflow:

- waits for `Publish OpenBesluitvorming Image` to finish successfully
- checks out the exact published commit
- connects to the beta server over SSH
- deploys the exact `sha-<short-git-sha>` image that was just published
- reuses the same safety logic as the local deploy script, so it will refuse to restart the app if imports are still `running`

That means the normal CD path is now:

1. push to `main`
2. GitHub Actions publishes the image
3. GitHub Actions automatically deploys the published image to beta

Required GitHub secret for this workflow:

- `BETA_DEPLOY_SSH_KEY`
  private SSH key that can log into `root@91.98.32.151`

### Manual Deploy

After CI has published the current commit image:

```sh
pnpm run deploy:beta
```

That script:

- resolves the current local Git commit SHA in the same short form GHCR publishes
- derives the GHCR image repository from the local `origin` remote by default
- checks deploy readiness on the server via `docker exec woozi-openbesluitvorming-1 deno eval ...` (port 8787 is only on the docker network, not the host)
- refuses to restart the app if imports are still `running` — use `FORCE=1` to override
- SSHes into the server
- runs `docker compose pull openbesluitvorming worker`
- restarts `openbesluitvorming`, `worker`, and `caddy`

Both `openbesluitvorming` and `worker` must be recreated on every deploy — they share the image and a code change to either process means both need the new image.

The script is:

- [scripts/deploy-beta.sh](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/scripts/deploy-beta.sh)

Useful overrides:

- `FORCE=1`
  bypass the running-import safety check
- `DEPLOY_REF=<short-sha>`
  deploy a specific already-published commit image, even if the local tree is dirty
- `DEPLOY_IMAGE=ghcr.io/<owner>/woozi-openbesluitvorming:<tag>`
  deploy an explicit image tag directly
- `IMAGE_REPOSITORY=ghcr.io/<owner>/woozi-openbesluitvorming`
  override the derived image repository

### Infra File Updates

Production still depends on a small set of repo-managed runtime files on the server:

- [docker-compose.production.yml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/docker-compose.production.yml)
- [Caddyfile](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/Caddyfile)
- [quickwit/quickwit.yaml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/quickwit/quickwit.yaml)

When those files change, sync them explicitly:

```sh
pnpm run deploy:beta:infra
```

That helper is:

- [scripts/deploy-beta-infra.sh](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/scripts/deploy-beta-infra.sh)

So the operational split is:

- code changes: publish image, then `deploy:beta`
- infra/config file changes: `deploy:beta:infra`

Operational rule:

- `/opt/woozi` on the server is runtime config, not an authoritative source tree
- if an emergency manual server-side build is ever needed, do it from a clearly temporary sync/build path, not from a long-lived stale checkout

## Import Concurrency

Imports are queued in-process and use a memory-aware concurrency limit.

Relevant env:

- `INGEST_CONCURRENCY`
  hard upper bound for parallel imports
- `INGEST_MEMORY_PER_JOB_MB`
  estimated memory budget per active import
- `INGEST_MIN_FREE_MEMORY_MB`
  reserve memory that should stay free before another import starts

Current intended production behavior:

- allow more than one import when the server has enough free memory
- avoid the earlier unbounded fan-out that caused OOM crashes

Example safe starting point on the current `cpx32` server:

- `INGEST_CONCURRENCY=4`
- `INGEST_MEMORY_PER_JOB_MB=1400`
- `INGEST_MIN_FREE_MEMORY_MB=1024`

When using remote extraction workers, the memory per job is much lower (PDF extraction is offloaded), so `INGEST_MEMORY_PER_JOB_MB` can be reduced to `600` and `INGEST_CONCURRENCY` can be raised. Current production values: `INGEST_CONCURRENCY=8`, `WOOZI_DOCUMENT_CONCURRENCY=10`.

Additional env for extraction:

- `WOOZI_EXTRACTION_SERVICE_URL`
  comma-separated list of extraction worker URLs (e.g. `http://10.0.1.3:8000,http://10.0.1.4:8000`).
  When set, PDF extraction is sent to remote workers via HTTP instead of spawning local pymupdf4llm subprocesses.
  The ingest worker round-robins requests across workers, with a 180s per-request timeout and one retry onto a different worker before failing the document.
  When empty or unset, falls back to local subprocess extraction.

- `WOOZI_DOCUMENT_CONCURRENCY`
  number of documents to process concurrently per import (default: 3).
  With remote extraction workers this can be raised (e.g. 10-30) since PDF extraction no longer uses local CPU.

- `WOOZI_IBABS_DATE_CHUNK_MONTHS`
  window size for splitting large iBabs SOAP calls (default: 6). A multi-year import is split into N calls of this size because iBabs returns all meetings in one response and the XML can grow large enough to time out server-side.

Warning: setting `INGEST_CONCURRENCY` above 8 on a single worker container doesn't help — the worker is a single Deno process (one vCPU ceiling). Past that point the event loop saturates with outbound HTTP connections before it saturates CPU. Future scaling path: run multiple `worker` containers with an atomic claim in `src/ops/store.ts` so they can share the queue without racing.

If the server becomes unresponsive after restart, the likely cause is too many queued imports resuming simultaneously. Fix by stopping the container, resetting queued/running imports in SQLite to `failed`, and restarting with lower concurrency.

Quickwit projection writes are now streamed during extraction in small batches instead of one big end-of-run push.

Relevant env:

- `QUICKWIT_BATCH_SIZE`
  number of entity commit events to buffer before ingesting to Quickwit

## Quickwit

Quickwit config lives in [quickwit/quickwit.yaml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/quickwit/quickwit.yaml).

Important current behavior:

- Quickwit stores index data in S3-compatible object storage
- metastore is also in S3-compatible object storage
- local disk still matters for runtime state and temp work, but persistent index storage is remote
- search latency is therefore influenced by object-storage round trips unless searcher caches are configured well

So this stack is not "just Node" and it is not "just the app container":

- `openbesluitvorming` serves search/admin/document APIs
- `quickwit` handles indexing/search
- S3-compatible object storage holds document artifacts and Quickwit index data

### Quickwit Search Tuning

The current production config now enables explicit Quickwit searcher caches.

Configured areas:

- in-memory fast field cache
- in-memory split footer cache
- in-memory partial request cache
- on-disk split cache under `data_dir`

This matters because the production stack stores both the metastore and the index splits in
S3-compatible object storage. Without these caches, repeated searches are much more exposed to:

- S3/object-storage latency variance
- repeated split downloads
- repeated fast-field reads for date filters and aggregations

Current default tuning for the `cpx32` box:

- `QUICKWIT_FAST_FIELD_CACHE_CAPACITY=1G`
- `QUICKWIT_SPLIT_FOOTER_CACHE_CAPACITY=512M`
- `QUICKWIT_PARTIAL_REQUEST_CACHE_CAPACITY=128M`
- `QUICKWIT_SPLIT_CACHE_MAX_NUM_BYTES=10G`
- `QUICKWIT_SPLIT_CACHE_MAX_NUM_SPLITS=10000`
- `QUICKWIT_SPLIT_CACHE_NUM_CONCURRENT_DOWNLOADS=2`

These are intentionally moderate values for an `8 GB` VM that is also running the app container.
If search remains slow after caches are warm, the next things to look at are:

- moving from `cpx32` to `cpx42` or a dedicated `ccx` instance
- separating heavy import activity from search traffic
- verifying that repeated queries are actually hitting the warm caches

### Quickwit Environment Split

Local and production must not share the same Quickwit metastore/index root in S3.

The repo now separates them by default:

- local/dev:
  - `QUICKWIT_CLUSTER_ID=woozi-dev`
  - `QUICKWIT_NODE_ID=quickwit-dev`
  - `QUICKWIT_INDEX_ROOT_PREFIX=indexes-dev`
  - `QUICKWIT_INDEX_ID=woozi-events-dev`
- production:
  - `QUICKWIT_CLUSTER_ID=woozi-prod`
  - `QUICKWIT_NODE_ID=quickwit-prod`
  - `QUICKWIT_INDEX_ROOT_PREFIX=indexes-prod`
  - `QUICKWIT_INDEX_ID=woozi-events-prod`

This prevents a local Quickwit instance from writing into the same S3-backed metastore and index as production.

### Production Migration Warning

If production previously used:

- S3 prefix `indexes`
- index id `woozi-events`

then switching production to:

- S3 prefix `indexes-prod`
- index id `woozi-events-prod`

creates a fresh Quickwit projection namespace.

That is usually the right long-term move, but it means production search will be empty until Quickwit is rebuilt for the new location/index id.

Treat this as a projection migration:

1. deploy the new env/config
2. recreate or ensure the new index
3. reindex/reimport into the new projection

Do not assume old search data under `indexes/woozi-events` will automatically appear under `indexes-prod/woozi-events-prod`.

## Hetzner Cloud

Current tested provisioning path:

- provider: Hetzner Cloud
- image: `docker-ce`
- location: `fsn1`
- reason: closest practical Hetzner region for Amsterdam

Current server created:

- name: `woozi-1`
- server type: `cpx32`
- location: `fsn1`
- image: `docker-ce`
- ipv4: `91.98.32.151`

DNS note:

- DNS is managed in Netlify
- the production domain `A` record should point to `91.98.32.151`

SSH:

```sh
ssh root@91.98.32.151
```

## Recommended Server Size

For this stack, the practical starting recommendation is:

- `cpx32`
- `4 vCPU`
- `8 GB RAM`
- `160 GB local disk`

This is a reasonable first deployment size for:

- one app container
- one Quickwit container
- external Hetzner Object Storage

If search volume or indexing pressure grows, move to:

- `cpx42`
- or dedicated `ccx` types if you want more predictable CPU

## Provisioning Notes

The Hetzner CLI (`hcloud`) was configured with context:

- `woozi`

Provisioning steps used:

1. create/upload SSH key
2. choose `fsn1`
3. create Docker CE app server
4. use current `cpx32` type because `cpx31` was not orderable in `fsn1`

Example commands:

```sh
hcloud ssh-key create --name joepio-ed25519 --public-key-from-file ~/.ssh/id_ed25519.pub
hcloud server create --name woozi-1 --type cpx32 --location fsn1 --image docker-ce --ssh-key joepio-ed25519
```

## Planned Production Layout

The production shape is:

- one Hetzner Cloud VM (`woozi-1`) for the app, Quickwit, and Caddy
- optional extraction worker VMs for PDF extraction during imports
- external Hetzner Object Storage
- `Caddy` in front for TLS termination and reverse proxy

The production compose file should use a published app image, not build on the server.

Production traffic:

```text
internet
  -> Caddy (:80 / :443)
  -> openbesluitvorming (:8787, private to the VM)
  -> quickwit (:7280, private to the VM)

During imports:
  openbesluitvorming -> extraction workers (:8000, separate VMs)
```

Quickwit should not be exposed publicly.

## Extraction Server

PDF extraction can be offloaded to a dedicated server running the `services/extraction/` Docker image. This is a stateless FastAPI service wrapping pymupdf4llm with multiple uvicorn worker processes.

Infrastructure is managed with OpenTofu in `infra/`.

### Architecture

Instead of many small cloud VMs, a single dedicated Hetzner server gives more CPU per euro:

| Server | Cores/Threads | RAM | Price/hour | Price/month |
|--------|--------------|-----|-----------|-------------|
| cpx22 (cloud) | 2 vCPU | 4 GB | €0.01 | €7.50 |
| AX41-NVMe | 6c/12t | 64 GB | €0.06 | €38 |
| EX44 | 14c/20t | 64 GB | €0.07 | €44 |

One AX41-NVMe (€0.06/hr) with 12 uvicorn workers replaces 6× cpx22 VMs (€0.06/hr total) and is simpler to manage.

### Provisioning

To spin up the extraction server for an import:

```sh
cd infra
TF_VAR_hcloud_token="..." tofu apply \
  -var="extraction_server_enabled=true" \
  -var="extraction_server_type=cpx22" \
  -var="extraction_uvicorn_workers=2"
```

For production imports with a dedicated server:

```sh
TF_VAR_hcloud_token="..." tofu apply \
  -var="extraction_server_enabled=true" \
  -var="extraction_server_type=ax41-nvme" \
  -var="extraction_uvicorn_workers=12"
```

To tear down after import:

```sh
TF_VAR_hcloud_token="..." tofu apply -var="extraction_server_enabled=false"
```

After provisioning, set `WOOZI_EXTRACTION_SERVICE_URL` on the ingest server to the extraction server URL from `tofu output extraction_service_url_env`. The worker firewall only allows port 8000 from the ingest server's IP (`91.98.32.151`).

The extraction service image is published to GHCR via `.github/workflows/publish-extraction.yml`.

The admin panel shows extraction server status (health, CPU load, request count) in the "Extractie-workers" section when `WOOZI_EXTRACTION_SERVICE_URL` is configured.

See [`docs/scaling-pdf-extraction.md`](docs/scaling-pdf-extraction.md) for detailed analysis and architecture options.

## HTTPS

The current recommended HTTPS setup is:

- `Caddy`
- automatic Let's Encrypt certificates
- reverse proxy from the public domain to `openbesluitvorming`

This is preferred over `nginx + certbot` because:

- less setup
- automatic certificate issuance
- automatic renewal
- simpler config for a single app deployment

The practical rule is:

- expose `80` and `443`
- point the domain `A` record at the Hetzner server
- let Caddy terminate TLS
- keep the app itself listening on `127.0.0.1:8787` or a Docker-internal address

Minimal `Caddyfile` shape:

```caddy
example.yourdomain.nl {
  encode gzip zstd
  reverse_proxy 127.0.0.1:8787
}
```

If the app stays inside Docker, a more typical production wiring is:

```caddy
example.yourdomain.nl {
  encode gzip zstd
  reverse_proxy openbesluitvorming:8787
}
```

That implies Caddy should join the same Docker network as the app container.

The repo now includes:

- [Caddyfile](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/Caddyfile)
- [docker-compose.production.yml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/docker-compose.production.yml)

That production compose file:

- exposes only `80` and `443` publicly through Caddy
- keeps `openbesluitvorming` internal to Docker via `expose: 8787`
- keeps Quickwit private
- expects `DOMAIN` plus the normal S3 env vars in `.env`

## Production Notes

For production on Hetzner Cloud:

- use the Docker CE marketplace image
- keep Vite out of the runtime entirely
- run `openbesluitvorming`, `worker`, `quickwit`, and `caddy` as the deployed stack
- use the real `.env` for Hetzner Object Storage
- do not start local MinIO

The expected public endpoint is the Caddy domain, not port `8787` directly.

## Production Commands

Current preferred deployment flow is image-based from the local machine:

```sh
pnpm run deploy:beta
```

Manual recovery on the server should normally be:

```sh
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

Required `.env` values for that production compose file:

- `DOMAIN`
- `ADMIN_PASSWORD_HASH`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_STORAGE_BUCKET_NAME`
- `S3_STORAGE_ENDPOINT`
- `S3_STORAGE_REGION`

First DNS step:

- point the domain `A` record at the server IP
- DNS for this setup is managed in Netlify
- wait for DNS to resolve before bringing up Caddy for the first time

## Admin Protection

The current recommended protection for the admin UI is:

- Caddy HTTP Basic Auth
- only on `/admin`, `/admin.html`, and `/api/admin/*`

Public search/document routes remain open.

Required env:

- `ADMIN_PASSWORD_HASH`

That value should be a Caddy password hash, not a plaintext password.
Because Docker Compose reads `.env`, bcrypt dollar signs must be escaped there as `$$`.

Example generation:

```sh
docker run --rm caddy:2 caddy hash-password --plaintext 'your-strong-password'
```

Example `.env` value:

```env
ADMIN_PASSWORD_HASH=$$2a$$14$$exampleexampleexampleexampleexampleexampleexampleexample
```

## Known Operational Notes

- interrupted imports can leave stale run-state unless reconciled on startup
- startup reconciliation for interrupted runs is now implemented in [src/ops/store.ts](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/src/ops/store.ts)
- duplicate active imports for the same source/date/execution mode are blocked in [src/ingest.ts](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/src/ingest.ts)
- background imports are now queued in SQLite and executed by the `worker` container (`src/worker.ts`), separate from the HTTP-serving `openbesluitvorming` container
- the current production behavior is memory-aware concurrency, not a fixed `1`
- large aggregate imports should therefore mostly appear as many `queued` runs plus a bounded number of `running` runs
- admin now has a queue/status summary backed by `/api/admin/summary`
- startup marks previously `running` imports as `failed` (not resumed) and starts `queued` imports from scratch
- aggregate imports are now supplier-specific, such as `__supplier__:notubiz` and `__supplier__:ibabs`
- the deploy helper now refuses to restart the app while imports are still running, unless forced
- browser-side fetch helpers now handle empty/non-JSON 500 responses more safely
- resuming many queued imports on startup with high concurrency can make the server unresponsive (event loop saturated with HTTP connections). If this happens: stop the container, reset queued/running rows in SQLite to `failed`, restart with lower concurrency
- **every outbound fetch on the ingest path has an explicit timeout.** Observed failure mode: iBabs/Notubiz/Quickwit/extraction workers occasionally hold a TCP connection open without responding, and a slot hangs for hours — in one incident 7 of 8 slots were wedged for 10+ hours. All fetches now cap at 90-180s with retries on `TimeoutError`/`AbortError`. Any new `fetch()` call in the ingest path must keep this pattern.
- iBabs is IPv4-whitelisted. The client forces IPv4-first DNS resolution via `node:dns.setDefaultResultOrder("ipv4first")`. On a dual-stack host without this, iBabs requests silently try IPv6 first and get rejected.
- the admin dashboard polls every 5s. It used to refetch per-run issue details for every run in the list (50+ parallel requests/poll), which pegged the single-threaded `openbesluitvorming` process during big imports and slowed user searches to 18s+. Now it only refetches when a run's `issue_count` has grown. Keep dashboard work per poll small.

## Keep Updated When These Change

Update this file whenever any of the following change:

- cloud provider or region
- server type
- object storage strategy
- Docker/runtime topology
- production entrypoint
- reverse proxy choice
- one-command dev workflow
- extraction worker topology or scaling approach
- Hetzner account limits
