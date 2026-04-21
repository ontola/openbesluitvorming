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
} from "./ops/store.ts";
import { computeAllowedIngestConcurrency } from "./ingest_scheduler.ts";

const POLL_INTERVAL_MS = 5000;

// Stable id for this worker process so log output distinguishes replicas.
const workerId = Deno.env.get("WORKER_ID") ??
  `${Deno.hostname()}.${crypto.randomUUID().slice(0, 8)}`;

const ingestConcurrencyCap = Math.max(1, Number(Deno.env.get("INGEST_CONCURRENCY") ?? "4"));
const ingestMemoryPerJobMb = Math.max(
  256,
  Number(Deno.env.get("INGEST_MEMORY_PER_JOB_MB") ?? "1400"),
);
const ingestMinFreeMemoryMb = Math.max(
  256,
  Number(Deno.env.get("INGEST_MIN_FREE_MEMORY_MB") ?? "1024"),
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
        await executeIngest(
          runningRun,
          run.source_key,
          run.date_from,
          run.date_to,
          {
            ingestToQuickwit: true,
            trigger: run.trigger,
            executionMode: run.execution_mode,
            parentRunId: run.parent_run_id ?? undefined,
          },
        );
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
  console.log(`[worker ${workerId}] reconciled ${reconciled.length} interrupted import(s) on startup.`);
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
