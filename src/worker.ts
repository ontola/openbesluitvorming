/**
 * Import worker — polls SQLite for queued imports and executes them.
 * Runs as a separate process from the web server so imports don't
 * affect search performance.
 */

import { executeIngest } from "./ingest.ts";
import {
  appendOpsJobOutput,
  claimQueuedOpsJob,
  claimQueuedRun,
  finishOpsJob,
  listQueuedRuns,
  type OpsJobRecord,
  reconcileInterruptedOpsJobs,
  reconcileInterruptedRuns,
  releaseOpsJob,
  updateRun,
} from "./ops/store.ts";
import { executeOpsJob } from "./ops/jobs.ts";
import { computeAllowedIngestConcurrency } from "./ingest_scheduler.ts";
import { IngestStallError, raceStallWatchdog } from "./ingest_watchdog.ts";
import { ingestStallTimeoutMs } from "./ingest_stall_timeout.ts";
import type { IngestRunRecord } from "./types.ts";

const POLL_INTERVAL_MS = 5000;

// Stable id for this worker process so log output distinguishes replicas.
const workerId =
  Deno.env.get("WORKER_ID") ?? `${Deno.hostname()}.${crypto.randomUUID().slice(0, 8)}`;

const ingestConcurrencyCap = Math.max(1, Number(Deno.env.get("INGEST_CONCURRENCY") ?? "1"));
const ingestMemoryPerJobMb = Math.max(
  256,
  Number(Deno.env.get("INGEST_MEMORY_PER_JOB_MB") ?? "1400"),
);
const ingestMinFreeMemoryMb = Math.max(
  256,
  Number(Deno.env.get("INGEST_MIN_FREE_MEMORY_MB") ?? "1024"),
);
// A run that emits no progress for this long is treated as wedged.
// `executeIngest` can hang indefinitely without throwing (e.g. a stuck
// extraction-service connection); without this watchdog that pins
// `activeCount` and silently disables the worker.
//
// Derived from the longest deliberate backoff rather than written as its own
// number -- see ingest_stall_timeout.ts for what that cost when the two drifted
// apart.
const stallTimeoutMs = ingestStallTimeoutMs();

let activeCount = 0;
// Tracks currently-claimed runs so a deploy's SIGTERM can hand them back to
// the queue immediately (see the shutdown handler below) instead of leaving
// them for reconcileInterruptedRuns() to discover up to
// RECONCILE_MIN_CLAIM_AGE_MS later — and, more importantly, without burning
// one of the run's limited MAX_INTERRUPTED_REQUEUES attempts on what is
// routine deploy churn rather than a genuine crash.
const activeRuns = new Map<string, IngestRunRecord>();

function getAllowedConcurrency(): number {
  try {
    const memory = Deno.systemMemoryInfo();
    return computeAllowedIngestConcurrency({
      configuredConcurrency: ingestConcurrencyCap,
      availableMemoryBytes: memory.available,
      memoryPerJobMb: ingestMemoryPerJobMb,
      minFreeMemoryMb: ingestMinFreeMemoryMb,
    });
  } catch {
    return ingestConcurrencyCap;
  }
}

/**
 * Run an ingest under a progress watchdog.
 *
 * `executeIngest` can hang indefinitely without resolving or throwing — a
 * wedged extraction-service connection was observed freezing all workers for
 * ~38h. Because `activeCount` is only released in the caller's `finally`, a
 * frozen run permanently disables the worker. `raceStallWatchdog` rejects with
 * `IngestStallError` when no heartbeat arrives for `ingestStallTimeoutMs`; we
 * then mark the run failed and return, so the slot is freed. The detached
 * `executeIngest` promise may keep running (idle, blocked on I/O) until the
 * process is recycled — a true cancel needs an AbortSignal threaded through
 * the extractors, which is a follow-up.
 */
async function executeIngestWithWatchdog(
  runningRun: IngestRunRecord,
  run: IngestRunRecord,
): Promise<void> {
  try {
    await raceStallWatchdog({
      stallTimeoutMs,
      work: (heartbeat) =>
        executeIngest(runningRun, run.source_key, run.date_from, run.date_to, {
          ingestToQuickwit: true,
          trigger: run.trigger,
          executionMode: run.execution_mode,
          parentRunId: run.parent_run_id ?? undefined,
          onHeartbeat: heartbeat,
        }),
    });
  } catch (error) {
    if (!(error instanceof IngestStallError)) {
      throw error;
    }
    console.error(
      `[worker ${workerId}] run ${run.id} (${run.source_key}) STALLED — marking failed, freeing slot`,
    );
    await updateRun(run.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: `Worker watchdog: ${error.message}; run abandoned.`,
    }).catch((updateError) => {
      console.error(
        `[worker ${workerId}] could not mark stalled run ${run.id} failed:`,
        updateError,
      );
    });
  }
}

async function pollAndExecute(): Promise<void> {
  const allowed = getAllowedConcurrency();
  if (activeCount >= allowed) {
    return;
  }

  const queued = await listQueuedRuns();
  if (queued.length === 0) {
    return;
  }

  const slotsAvailable = allowed - activeCount;
  // Look ahead beyond free slots so that if our first picks lose the claim
  // race to another worker, we still have fallback candidates to try this
  // cycle instead of sleeping until the next poll.
  const batch = queued.slice(0, slotsAvailable * 3);

  for (const run of batch) {
    if (activeCount >= allowed) {
      break;
    }
    activeCount += 1;
    void (async () => {
      try {
        const runningRun = await claimQueuedRun(run.id);
        if (!runningRun) {
          // Another worker claimed this one between our list and our update.
          return;
        }
        activeRuns.set(runningRun.id, runningRun);
        console.log(`[worker ${workerId}] claimed ${run.source_key} (${run.id})`);
        await executeIngestWithWatchdog(runningRun, run);
      } catch (error) {
        console.error(`[worker ${workerId}] import failed for ${run.source_key}`, error);
      } finally {
        activeCount -= 1;
        activeRuns.delete(run.id);
      }
    })();
  }
}

// --- Ops jobs ---
//
// Actions queued through /api/ops/* (src/ops/jobs.ts). They run here rather
// than in the web container, one at a time per worker and outside the ingest
// slots: a purge is mostly waiting on object storage, and should neither wait
// for an import slot nor take one away.

let activeOpsJob: OpsJobRecord | null = null;
let opsJobBusy = false;

async function pollOpsJobs(): Promise<void> {
  if (opsJobBusy) {
    return;
  }
  opsJobBusy = true;
  try {
    const job = await claimQueuedOpsJob();
    if (job) {
      activeOpsJob = job;
      await runOpsJob(job);
    }
  } finally {
    activeOpsJob = null;
    opsJobBusy = false;
  }
}

async function runOpsJob(job: OpsJobRecord): Promise<void> {
  console.log(
    `[worker ${workerId}] claimed ops job ${job.id} (${job.action}, apply=${job.apply}, actor=${job.actor})`,
  );
  // Output is appended in order; a failed write is logged, never fatal.
  let pending = Promise.resolve();
  const log = (line: string) => {
    pending = pending.then(() =>
      appendOpsJobOutput(job.id, line).catch((error) => {
        console.error(`[worker ${workerId}] could not store output of ops job ${job.id}`, error);
      }),
    );
  };
  try {
    await executeOpsJob(job, log);
    await pending;
    await finishOpsJob(job.id, { status: "succeeded" });
    console.log(`[worker ${workerId}] ops job ${job.id} succeeded`);
  } catch (error) {
    await pending;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker ${workerId}] ops job ${job.id} failed: ${message}`);
    await finishOpsJob(job.id, { status: "failed", error: message }).catch((updateError) => {
      console.error(`[worker ${workerId}] could not mark ops job ${job.id} failed`, updateError);
    });
  }
}

// --- Startup ---

// Reconciliation runs in every worker on startup. It's idempotent — the first
// worker marks all previously `running` runs as failed, subsequent workers
// find none. Safe because every deploy restarts all workers together.
const reconciled = await reconcileInterruptedRuns();
if (reconciled.length > 0) {
  console.log(
    `[worker ${workerId}] reconciled ${reconciled.length} interrupted import(s) on startup.`,
  );
}

const reconciledOpsJobs = await reconcileInterruptedOpsJobs();
if (reconciledOpsJobs.length > 0) {
  console.log(
    `[worker ${workerId}] reconciled ${reconciledOpsJobs.length} interrupted ops job(s) on startup.`,
  );
}

console.log(
  `[worker ${workerId}] started (concurrency=${ingestConcurrencyCap}, poll=${POLL_INTERVAL_MS}ms)`,
);

// A deploy's `docker compose up -d` sends SIGTERM before recreating the
// container. Hand back any claimed runs right away — cheap local writes,
// well within the compose stop grace period — rather than leaving them for
// reconcile to find later at the cost of a retry attempt (see activeRuns
// above). executeIngest itself isn't cancelled; it keeps running until the
// container is actually killed, same as before this handler existed.
let shuttingDown = false;
async function releaseActiveRunsAndExit(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const runs = [...activeRuns.values()];
  if (runs.length > 0) {
    console.log(
      `[worker ${workerId}] SIGTERM: releasing ${runs.length} claimed run(s) back to the queue`,
    );
    await Promise.all(
      runs.map((run) =>
        updateRun(run.id, { status: "queued", error_message: undefined }).catch((error) => {
          console.error(`[worker ${workerId}] could not release run ${run.id} on shutdown:`, error);
        }),
      ),
    );
  }
  if (activeOpsJob) {
    console.log(`[worker ${workerId}] SIGTERM: releasing ops job ${activeOpsJob.id} to the queue`);
    await releaseOpsJob(activeOpsJob.id).catch((error) => {
      console.error(`[worker ${workerId}] could not release ops job on shutdown:`, error);
    });
  }
  Deno.exit(0);
}
Deno.addSignalListener("SIGTERM", () => void releaseActiveRunsAndExit());

// Poll loop
while (true) {
  try {
    await pollAndExecute();
  } catch (error) {
    console.error("Poll cycle error", error);
  }
  // Not awaited: an ops job can run for minutes and must not hold up the
  // ingest queue. pollOpsJobs returns at once while one is active.
  void pollOpsJobs().catch((error) => console.error("Ops job poll error", error));
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}
