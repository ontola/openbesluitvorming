# Deployment

This file documents the current deployment approach for `woozi/`.

It should be kept aligned with the real working setup, not an aspirational target.

## Current Shape

The app is currently designed to run as:

- one `openbesluitvorming` container
- one `quickwit` container
- external S3-compatible object storage

In the current setup, object storage is expected to come from environment configuration.
For Joep's setup, that is Hetzner Object Storage, not local MinIO.

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
- `WOOZI_KV_PATH`
- `INGEST_CONCURRENCY`

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

## Quickwit

Quickwit config lives in [quickwit/quickwit.yaml](/Users/joep/dev/github/openstate/open-raadsinformatie/woozi/quickwit/quickwit.yaml).

Important current behavior:

- Quickwit stores index data in S3-compatible object storage
- metastore is also in S3-compatible object storage
- local disk still matters for runtime state and temp work, but persistent index storage is remote

So this stack is not "just Node" and it is not "just the app container":

- `openbesluitvorming` serves search/admin/document APIs
- `quickwit` handles indexing/search
- S3-compatible object storage holds document artifacts and Quickwit index data

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

The intended simple production shape is:

- one Hetzner Cloud VM
- Docker Compose on the VM
- `quickwit` container
- `openbesluitvorming` container
- external Hetzner Object Storage
- `Caddy` in front for TLS termination and reverse proxy

Production traffic should look like:

```text
internet
  -> Caddy (:80 / :443)
  -> openbesluitvorming (:8787, private to the VM)
  -> quickwit (:7280, private to the VM)
```

Quickwit should not be exposed publicly.

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
- run `openbesluitvorming`, `quickwit`, and `caddy` as the deployed stack
- use the real `.env` for Hetzner Object Storage
- do not start local MinIO

The expected public endpoint is the Caddy domain, not port `8787` directly.

## Production Commands

Current preferred deployment flow is Git-over-SSH from the local repo, not `rsync`.

Deploy from the local machine:

```sh
pnpm run deploy:beta
```

That script:

- refuses to deploy if the local tree is dirty
- bootstraps a bare repo at `/opt/woozi.git` on the server if needed
- pushes the selected Git ref over SSH
- checks it out into `/opt/woozi-git`
- reuses the existing `/opt/woozi/.env` on first deploy
- runs production compose from `/opt/woozi-git` with `COMPOSE_PROJECT_NAME=woozi`

The older direct server command still works for manual recovery:

```sh
docker compose -f docker-compose.production.yml up -d --build
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
- background imports are now queued in-process with bounded concurrency from `INGEST_CONCURRENCY`
- default ingest concurrency is `1`, which is the intended safe production setting for now
- large aggregate imports should therefore mostly appear as many `queued` runs and one `running` run
- admin now has a queue/status summary backed by `/api/admin/summary`
- browser-side fetch helpers now handle empty/non-JSON 500 responses more safely

## Keep Updated When These Change

Update this file whenever any of the following change:

- cloud provider or region
- server type
- object storage strategy
- Docker/runtime topology
- production entrypoint
- reverse proxy choice
- one-command dev workflow
