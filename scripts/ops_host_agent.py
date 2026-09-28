#!/usr/bin/env python3
"""Host side of the ops endpoint: the few actions that need Docker.

`/api/ops/*` (web/ops_api.ts) queues every action as an `ops_job` row in the
ops SQLite. The Deno worker runs most of them, but restarting a service and
reading its logs need the Docker daemon, and no container is given the Docker
socket: a socket in the web container would make the ops token worth as much
as root on the host. So those two actions are claimed here instead, by this
script, run every 15 seconds by woozi-ops-agent.timer
(scripts/install-production-ops-agent.sh).

Each tick it:
  1. records every compose service's state in `host_service_status`, which
     `GET /api/ops/health` returns as `services`;
  2. fails host jobs that have been running too long (the agent died mid-job);
  3. claims queued `restart_service` / `service_logs` jobs one by one and runs
     them, writing the output into the job row.

It runs nothing but `docker compose ps`, `restart <service>` and
`logs <service>`, for the services allow-listed below, and re-checks every
parameter even though the web container validated it: a row is not trusted
for being in the table. Keep the lists in sync with src/ops/jobs.ts.

Standard library only; the host has python3 and nothing else we can rely on.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HOST_ACTIONS = ("restart_service", "service_logs")
RESTARTABLE_SERVICES = ("worker", "openbesluitvorming", "otel-collector", "quickwit")
LOGGABLE_SERVICES = RESTARTABLE_SERVICES + ("caddy",)
MAX_LOG_SINCE_MINUTES = 24 * 60
MAX_LOG_LINES = 2000
# Same cap as OPS_JOB_OUTPUT_LIMIT in src/ops/store.ts.
OUTPUT_LIMIT = 64 * 1024
# A restart waits for the container's stop grace period; the worker hands its
# runs back on SIGTERM, which can take a while under load.
RESTART_TIMEOUT_SECONDS = 300
LOGS_TIMEOUT_SECONDS = 60
PS_TIMEOUT_SECONDS = 30
# A host job still `running` after this was abandoned by a dead agent.
STALE_JOB_MINUTES = 15
# Jobs per tick, so one tick cannot run for ever when many are queued.
MAX_JOBS_PER_TICK = 5

OPS_DB = os.environ.get(
    "WOOZI_OPS_DB", "/var/lib/docker/volumes/woozi_woozi-state/_data/woozi-ops.sqlite3"
)
COMPOSE_DIR = os.environ.get("WOOZI_COMPOSE_DIR", "/opt/woozi")
COMPOSE_FILE = os.environ.get("WOOZI_COMPOSE_FILE", "docker-compose.production.yml")
DOCKER = os.environ.get("WOOZI_DOCKER", "docker")


def now_iso() -> str:
    # The same shape as JavaScript's toISOString(), so string comparisons in
    # SQL line up with the rows the Deno side writes.
    moment = datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def compose(*args: str, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [DOCKER, "compose", "-f", COMPOSE_FILE, *args],
        cwd=COMPOSE_DIR,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(OPS_DB, timeout=30, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    return db


# --- service status ---------------------------------------------------------


def parse_ps(text: str) -> list[dict]:
    """`docker compose ps --format json` prints one object per line on current
    Compose, and a single array on releases before 2.21."""
    text = text.strip()
    if not text:
        return []
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def summarize_services(containers: list[dict]) -> dict[str, dict]:
    services: dict[str, dict] = {}
    for container in containers:
        name = container.get("Service") or container.get("Name") or "unknown"
        state = container.get("State") or "unknown"
        entry = services.setdefault(
            name, {"state": state, "health": None, "status": None, "replicas": 0}
        )
        entry["replicas"] += 1
        # One stopped replica makes the service not "running".
        if state != "running":
            entry["state"] = state
        health = container.get("Health") or None
        if health and entry["health"] in (None, "healthy"):
            entry["health"] = health
        entry["status"] = container.get("Status") or entry["status"]
    return services


def record_service_status(db: sqlite3.Connection) -> None:
    result = compose("ps", "--all", "--format", "json", timeout=PS_TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise RuntimeError(f"docker compose ps failed: {result.stderr.strip()[:300]}")
    services = summarize_services(parse_ps(result.stdout))
    seen_at = now_iso()
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("DELETE FROM host_service_status")
        for name, entry in sorted(services.items()):
            db.execute(
                """INSERT INTO host_service_status
                   (service, state, health, status, replicas, seen_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (name, entry["state"], entry["health"], entry["status"], entry["replicas"], seen_at),
            )
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise


# --- jobs --------------------------------------------------------------------

PLACEHOLDERS = ", ".join("?" for _ in HOST_ACTIONS)


def fail_stale_jobs(db: sqlite3.Connection) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=STALE_JOB_MINUTES)).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    cursor = db.execute(
        f"""UPDATE ops_job SET status = 'failed', finished_at = ?,
              error = 'Host agent stopped while running this job; it was not retried.'
            WHERE status = 'running' AND action IN ({PLACEHOLDERS})
              AND COALESCE(claimed_at, started_at, created_at) < ?""",
        (now_iso(), *HOST_ACTIONS, cutoff),
    )
    return cursor.rowcount


def claim_job(db: sqlite3.Connection) -> sqlite3.Row | None:
    now = now_iso()
    return db.execute(
        f"""UPDATE ops_job
            SET status = 'running', started_at = ?, claimed_at = ?, error = NULL
            WHERE id = (
              SELECT id FROM ops_job
              WHERE status = 'queued' AND action IN ({PLACEHOLDERS})
              ORDER BY created_at LIMIT 1
            ) AND status = 'queued'
            RETURNING id, action, params, apply, actor""",
        (now, now, *HOST_ACTIONS),
    ).fetchone()


def finish_job(db: sqlite3.Connection, job_id: str, output: str, error: str | None) -> None:
    # Keep the end of long output: for logs the newest lines are the point.
    if len(output) > OUTPUT_LIMIT:
        output = "[... older output dropped ...]\n" + output[-(OUTPUT_LIMIT - 40) :]
    db.execute(
        """UPDATE ops_job SET status = ?, finished_at = ?, error = ?, output = ?
           WHERE id = ? AND status = 'running'""",
        ("failed" if error else "succeeded", now_iso(), error, output, job_id),
    )


class JobError(Exception):
    pass


def bounded(params: dict, key: str, fallback: int, maximum: int) -> int:
    value = params.get(key, fallback)
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= maximum:
        raise JobError(f"{key} must be a whole number from 1 to {maximum}")
    return value


def run_restart(params: dict, apply: bool) -> str:
    service = params.get("service")
    if service not in RESTARTABLE_SERVICES:
        raise JobError(f"service must be one of {', '.join(RESTARTABLE_SERVICES)}")
    command = f"docker compose -f {COMPOSE_FILE} restart {service}"
    if not apply:
        before = compose("ps", "--all", "--format", "json", service, timeout=PS_TIMEOUT_SECONDS)
        state = summarize_services(parse_ps(before.stdout)).get(service)
        current = f"{state['replicas']} container(s), {state['state']}" if state else "not found"
        return f"[dry-run] Would run: {command}\nCurrent state: {current}\n"
    result = compose("restart", service, timeout=RESTART_TIMEOUT_SECONDS)
    output = f"$ {command}\n{result.stdout}{result.stderr}"
    if result.returncode != 0:
        raise JobError(f"restart exited {result.returncode}\n{output}")
    after = compose("ps", "--all", "--format", "json", service, timeout=PS_TIMEOUT_SECONDS)
    state = summarize_services(parse_ps(after.stdout)).get(service)
    if state:
        output += f"After restart: {state['replicas']} container(s), {state['state']}\n"
    return output


def run_logs(params: dict) -> str:
    service = params.get("service")
    if service not in LOGGABLE_SERVICES:
        raise JobError(f"service must be one of {', '.join(LOGGABLE_SERVICES)}")
    since = bounded(params, "sinceMinutes", 60, MAX_LOG_SINCE_MINUTES)
    lines = bounded(params, "lines", 200, MAX_LOG_LINES)
    result = compose(
        "logs",
        "--no-color",
        "--timestamps",
        "--since",
        f"{since}m",
        "--tail",
        str(lines),
        service,
        timeout=LOGS_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise JobError(f"logs exited {result.returncode}: {result.stderr.strip()[:500]}")
    # --tail is per container; with several worker replicas that is several
    # times `lines`. Keep the newest `lines` across all of them.
    collected = (result.stdout + result.stderr).splitlines()
    return "\n".join(collected[-lines:]) + "\n"


def run_job(db: sqlite3.Connection, job: sqlite3.Row) -> None:
    job_id = job["id"]
    log(f"claimed ops job {job_id} ({job['action']}, apply={bool(job['apply'])}, actor={job['actor']})")
    try:
        params = json.loads(job["params"])
        if not isinstance(params, dict):
            raise JobError("params must be an object")
        if job["action"] == "restart_service":
            output = run_restart(params, bool(job["apply"]))
        elif job["action"] == "service_logs":
            output = run_logs(params)
        else:
            raise JobError(f"not a host action: {job['action']}")
        finish_job(db, job_id, output, None)
        log(f"ops job {job_id} succeeded")
    except (JobError, subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as error:
        message = str(error)
        finish_job(db, job_id, "", message[:2000])
        log(f"ops job {job_id} failed: {message.splitlines()[0] if message else error!r}")


def log(message: str) -> None:
    print(f"[ops-host-agent] {message}", flush=True)


def tick() -> int:
    db = connect()
    try:
        failures = 0
        try:
            record_service_status(db)
        except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError, sqlite3.Error) as error:
            # Status is best effort; jobs must still run.
            failures += 1
            log(f"could not record service status: {error}")
        stale = fail_stale_jobs(db)
        if stale:
            log(f"failed {stale} abandoned host job(s)")
        for _ in range(MAX_JOBS_PER_TICK):
            job = claim_job(db)
            if job is None:
                break
            run_job(db, job)
        return failures
    finally:
        db.close()


if __name__ == "__main__":
    if not os.path.exists(OPS_DB):
        log(f"ops database not found at {OPS_DB}")
        sys.exit(1)
    sys.exit(1 if tick() else 0)
