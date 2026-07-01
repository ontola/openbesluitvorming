/**
 * Import worker — polls SQLite for queued imports and executes them.
 * Runs as a separate process from the web server so imports don't
 * affect search performance.
 */

import { executeIngest } from "./ingest.ts";
import {
  claimQueuedRun,
  listQueuedRuns,
  reconcileInterruptedRuns,
  updateRun,
} from "./ops/store.ts";
import { computeAllowedIngestConcurrency } from "./ingest_scheduler.ts";
import { IngestStallError, raceStallWatchdog } from "./ingest_watchdog.ts";
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
// A run that emits no progress for this long is treated as wedged. `executeIngest`
// can hang indefinitely without throwing (e.g. a stuck extraction-service
// connection); without this watchdog that pins `activeCount` and silently
// disables the worker. Default 10 min — well above any healthy inter-entity gap.
const ingestStallTimeoutMs = Math.max(
  60_000,
  Number(Deno.env.get("INGEST_STALL_TIMEOUT_MS") ?? "600000"),
);

let activeCount = 0;

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
      stallTimeoutMs: ingestStallTimeoutMs,
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
        console.log(`[worker ${workerId}] claimed ${run.source_key} (${run.id})`);
        await executeIngestWithWatchdog(runningRun, run);
      } catch (error) {
        console.error(`[worker ${workerId}] import failed for ${run.source_key}`, error);
      } finally {
        activeCount -= 1;
      }
    })();
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

console.log(
  `[worker ${workerId}] started (concurrency=${ingestConcurrencyCap}, poll=${POLL_INTERVAL_MS}ms)`,
);

// Poll loop
while (true) {
  try {
    await pollAndExecute();
  } catch (error) {
    console.error("Poll cycle error", error);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}
