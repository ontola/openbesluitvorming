/**
 * Import worker — polls SQLite for queued imports and executes them.
 * Runs as a separate process from the web server so imports don't
 * affect search performance.
 */

import { executeIngest } from "./ingest.ts";
import {
  listQueuedRuns,
  reconcileInterruptedRuns,
  updateRun,
} from "./ops/store.ts";
import { computeAllowedIngestConcurrency } from "./ingest_scheduler.ts";

const POLL_INTERVAL_MS = 5000;

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
  const batch = queued.slice(0, slotsAvailable);

  for (const run of batch) {
    activeCount += 1;
    void (async () => {
      try {
        const runningRun = await updateRun(run.id, {
          status: "running",
          error_message: undefined,
        });
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
        console.error("Import failed", error);
      } finally {
        activeCount -= 1;
      }
    })();
  }
}

// --- Startup ---

const reconciled = await reconcileInterruptedRuns();
if (reconciled.length > 0) {
  console.log(`Reconciled ${reconciled.length} interrupted import(s) on startup.`);
}

console.log(
  `Import worker started (concurrency=${ingestConcurrencyCap}, poll=${POLL_INTERVAL_MS}ms)`,
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
