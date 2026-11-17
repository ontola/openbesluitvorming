// Workers take queued runs in listQueuedRuns() order. A bulk re-import
// enqueues hundreds of runs; the daily scheduler's runs must not wait behind
// them, or no source gets a fresh import until the backlog drains (seen on
// 4 and 5 November 2026 behind an iBabs motions_only backfill).
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { createRun, listQueuedRuns } from "../src/ops/store.ts";
import { currentDerivationVersion, currentProjectionVersion } from "../src/pipeline/versioning.ts";
import type { IngestRunTrigger } from "../src/types.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

async function makeRun(sourceKey: string, trigger: IngestRunTrigger) {
  await createRun({
    source_key: sourceKey,
    supplier: "notubiz",
    date_from: "2020-01-01",
    date_to: "2020-12-31",
    trigger,
    execution_mode: "full",
    parent_run_id: undefined,
    projection_version: currentProjectionVersion(),
    derivation_version: currentDerivationVersion(),
    status: "queued",
  });
  // started_at has millisecond resolution; keep the enqueue order unambiguous.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

Deno.test("daily scheduled runs are taken before an older bulk backlog", async () => {
  await makeRun("bulk_a", "user");
  await makeRun("bulk_b", "backfill");
  await makeRun("targeted", "api");
  await makeRun("daily_a", "scheduled");
  await makeRun("daily_b", "scheduled");

  const order = (await listQueuedRuns()).map((run) => run.source_key);
  assertEquals(
    order,
    ["daily_a", "daily_b", "bulk_a", "bulk_b", "targeted"],
    "scheduled first, then the rest oldest first",
  );
});
