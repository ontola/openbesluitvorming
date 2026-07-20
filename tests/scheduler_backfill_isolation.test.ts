// The daily scheduler skips its own enqueue while countActiveScheduledRuns()
// is nonzero, to avoid double-enqueuing an overlapping cycle. Full-history
// backfill runs share the queue and worker pool but must NOT count toward
// that check -- otherwise a multi-week backfill starves the daily cadence
// entirely (observed: the scheduler didn't fire from 2026-07-12 onward once
// its own trigger value was reused for backfill enqueues).
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { countActiveScheduledRuns, createRun } from "../src/ops/store.ts";
import { currentDerivationVersion, currentProjectionVersion } from "../src/pipeline/versioning.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function makeRun(trigger: "scheduled" | "backfill", dateFrom: string, dateTo: string) {
  await createRun({
    source_key: "haarlem",
    supplier: "notubiz",
    date_from: dateFrom,
    date_to: dateTo,
    trigger,
    execution_mode: "full",
    parent_run_id: undefined,
    projection_version: currentProjectionVersion(),
    derivation_version: currentDerivationVersion(),
    status: "queued",
  });
}

Deno.test("countActiveScheduledRuns ignores backfill-triggered runs", async () => {
  assert((await countActiveScheduledRuns()) === 0, "starts at zero");

  await makeRun("backfill", "2010-01-01", "2011-01-01");
  await makeRun("backfill", "2011-01-01", "2012-01-01");
  assert(
    (await countActiveScheduledRuns()) === 0,
    "backfill-triggered full-history runs must not block the daily scheduler",
  );

  await makeRun("scheduled", "2026-07-13", "2026-07-27");
  assert(
    (await countActiveScheduledRuns()) === 1,
    "a genuine daily-scheduler run is still counted",
  );
});
