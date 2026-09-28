/**
 * Re-enqueue failed/partial full-history backfill windows.
 *
 * Shared by `scripts/reenqueue_failed_windows.ts` (CLI) and the ops endpoint's
 * `reenqueue_failed_windows` action. See the script for the history of why
 * these windows exist and which filters give the highest yield.
 */

import { createRun, findActiveRun, listFailedBackfillWindows } from "./store.ts";
import { currentDerivationVersion, currentProjectionVersion } from "../pipeline/versioning.ts";

export type ReenqueueStatus = "failed" | "partial";

export interface ReenqueueOptions {
  apply: boolean;
  source?: string;
  /** Only full-history chunks (12-month windows), not the 14-day daily
   * scheduler windows -- identified by width. */
  minWindowDays: number;
  fromYear?: string;
  toYear?: string;
  statuses: ReenqueueStatus[];
}

export interface ReenqueueResult {
  windows: number;
  enqueued: number;
  skipped: number;
}

export const DEFAULT_REENQUEUE_STATUSES: ReenqueueStatus[] = ["failed", "partial"];
export const DEFAULT_MIN_WINDOW_DAYS = 20;

/** Parse a comma-separated status list; throws on anything but the two
 * outcomes worth retrying. */
export function parseReenqueueStatuses(value: string): ReenqueueStatus[] {
  const statuses = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const status of statuses) {
    if (status !== "failed" && status !== "partial") {
      throw new Error(`Unknown --status value ${status}; expected "failed" and/or "partial".`);
    }
  }
  return statuses as ReenqueueStatus[];
}

export async function reenqueueFailedWindows(
  options: ReenqueueOptions,
  log: (line: string) => void = console.log,
): Promise<ReenqueueResult> {
  const rows = await listFailedBackfillWindows({
    statuses: options.statuses,
    minWindowDays: options.minWindowDays,
    sourceKey: options.source,
    fromYear: options.fromYear,
    toYear: options.toYear,
  });

  log(
    `${options.apply ? "Re-enqueueing" : "[dry-run] Would re-enqueue"} ${rows.length} failed/partial window(s)` +
      (options.source ? ` for source ${options.source}` : "") +
      ".",
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
    if (options.apply) {
      await createRun({
        source_key: row.source_key,
        supplier: row.supplier,
        date_from: row.date_from,
        date_to: row.date_to,
        trigger: "backfill",
        execution_mode: "full",
        parent_run_id: undefined,
        projection_version: currentProjectionVersion(),
        derivation_version: currentDerivationVersion(),
        status: "queued",
      });
    }
    enqueued += 1;
  }

  log(
    `${options.apply ? "Enqueued" : "[dry-run] Would enqueue"} ${enqueued} runs (${skipped} skipped as already active).`,
  );
  return { windows: rows.length, enqueued, skipped };
}
