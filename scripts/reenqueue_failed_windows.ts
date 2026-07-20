/**
 * Re-enqueue failed/partial full-history backfill windows.
 *
 * The initial backfill pass (scripts/enqueue_full_history.ts) left many
 * windows failed or partial -- mostly due to bugs since fixed (retryable
 * extraction errors treated as terminal, dead sources, iBabs
 * misclassification of empty windows, worker-restart interruptions). This
 * re-enqueues exactly those (source_key, date_from, date_to) windows as
 * fresh queued runs, landing at the tail of the FIFO queue behind the
 * ongoing first pass. Windows that have since succeeded are skipped.
 *
 * Cheap to run: everything already cached (S3/export-log) comes back as a
 * cache hit, so only the genuinely still-missing documents cost anything.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   deno run -A scripts/reenqueue_failed_windows.ts                # dry-run
 *   deno run -A scripts/reenqueue_failed_windows.ts --apply
 *   deno run -A scripts/reenqueue_failed_windows.ts --source soest --apply
 */

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createRun, findActiveRun } from "../src/ops/store.ts";
import { currentDerivationVersion, currentProjectionVersion } from "../src/pipeline/versioning.ts";
import { getConfigValue } from "../src/config.ts";

const { values: args } = parseArgs({
  args: Deno.args,
  options: {
    apply: { type: "boolean", default: false },
    source: { type: "string" },
    // Only re-enqueue full-history chunks (12-month backfill windows), not
    // the 14-day daily-scheduler windows -- identified by width, since both
    // share trigger_mode="scheduled".
    "min-window-days": { type: "string", default: "20" },
  },
});

const dbPath = await getConfigValue("WOOZI_KV_PATH", "./woozi-ops.sqlite3");
const readDb = new DatabaseSync(dbPath, { readOnly: true });

const rows = readDb
  .prepare(
    `SELECT DISTINCT r.source_key, r.supplier, r.date_from, r.date_to
     FROM ingest_run r
     WHERE r.trigger_mode = 'scheduled'
       AND r.execution_mode = 'full'
       AND r.status IN ('failed', 'partial')
       AND (julianday(r.date_to) - julianday(r.date_from)) > @min_window_days
       AND (@source IS NULL OR r.source_key = @source)
       AND NOT EXISTS (
         SELECT 1 FROM ingest_run r2
         WHERE r2.source_key = r.source_key
           AND r2.date_from = r.date_from
           AND r2.date_to = r.date_to
           AND r2.status = 'succeeded'
       )
     ORDER BY r.date_from DESC`,
  )
  .all({
    min_window_days: Number(args["min-window-days"]),
    source: args.source ?? null,
  }) as Array<{ source_key: string; supplier: string; date_from: string; date_to: string }>;

readDb.close();

console.log(
  `${args.apply ? "Re-enqueueing" : "[dry-run] Would re-enqueue"} ${rows.length} failed/partial window(s)` +
    (args.source ? ` for source ${args.source}` : "") + ".",
);

let enqueued = 0;
let skipped = 0;

for (const row of rows) {
  const existing = await findActiveRun({
    sourceKey: row.source_key,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    executionMode: "full",
  });
  if (existing) {
    skipped += 1;
    continue;
  }
  if (args.apply) {
    await createRun({
      source_key: row.source_key,
      supplier: row.supplier,
      date_from: row.date_from,
      date_to: row.date_to,
      trigger: "scheduled",
      execution_mode: "full",
      parent_run_id: undefined,
      projection_version: currentProjectionVersion(),
      derivation_version: currentDerivationVersion(),
      status: "queued",
    });
  }
  enqueued += 1;
}

console.log(
  `${args.apply ? "Enqueued" : "[dry-run] Would enqueue"} ${enqueued} runs (${skipped} skipped as already active).`,
);
