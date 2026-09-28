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
 *
 * Highest-yield first: --status/--from-year/--to-year narrow the sweep so a
 * short, high-value pass can run ahead of the long tail. Coverage analysis
 * on 2026-07-30 found 2012-2014 were the real holes (2013: 316 of 330
 * sources had no successful run at all), caused by "database is locked"
 * contention on 2026-07-12 when the backfill was first enqueued -- our own
 * bug, so the documents are still at the source. Those `failed` windows had
 * ingested zero documents, while `partial` windows already hold most of
 * theirs:
 *
 *   deno run -A scripts/reenqueue_failed_windows.ts \
 *     --status failed --from-year 2012 --to-year 2014 --apply
 */

import { parseArgs } from "node:util";
import {
  DEFAULT_MIN_WINDOW_DAYS,
  parseReenqueueStatuses,
  reenqueueFailedWindows,
  type ReenqueueStatus,
} from "../src/ops/reenqueue_failed_windows.ts";

const { values: args } = parseArgs({
  args: Deno.args,
  options: {
    apply: { type: "boolean", default: false },
    source: { type: "string" },
    // Only re-enqueue full-history chunks (12-month backfill windows), not
    // the 14-day daily-scheduler windows -- identified by width. Matches
    // both trigger values since older backfill rows may still carry
    // "scheduled" from before it was split out into "backfill".
    "min-window-days": { type: "string", default: String(DEFAULT_MIN_WINDOW_DAYS) },
    // Narrow the sweep to the window's start year, so the highest-yield
    // periods can be re-run first instead of queueing everything at once.
    "from-year": { type: "string" },
    "to-year": { type: "string" },
    // Which prior outcomes to retry. "failed" windows are the pure gaps --
    // measured 2026-07-30, the 2012/2013 failures had ingested *zero*
    // documents -- whereas "partial" windows already hold most of their
    // content, so retrying them costs the same but recovers far less.
    status: { type: "string", default: "failed,partial" },
  },
});

let statuses: ReenqueueStatus[];
try {
  statuses = parseReenqueueStatuses(args.status);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}

await reenqueueFailedWindows({
  apply: args.apply,
  source: args.source,
  minWindowDays: Number(args["min-window-days"]),
  fromYear: args["from-year"],
  toYear: args["to-year"],
  statuses,
});
