/**
 * Daily scheduler — enqueues rolling-window imports for all runnable sources
 * at a fixed wall-clock time (Europe/Amsterdam). Workers pick them up through
 * the existing SQLite queue.
 *
 * Scope is intentionally small: one timer in the openbesluitvorming container
 * writes queued rows; no coordination needed with the worker containers.
 */

import { createRun, findActiveRun } from "./ops/store.ts";
import { listRunnableCatalogSources } from "./sources/index.ts";
import {
  currentDerivationVersion,
  currentProjectionVersion,
} from "./pipeline/versioning.ts";

const WINDOW_DAYS_BEFORE = 7;
const WINDOW_DAYS_AFTER = 7;
const SCHEDULE_HOUR_AMSTERDAM = 4;
const DAY_MS = 86_400_000;

function amsterdamOffsetHours(date: Date): number {
  const tz = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam",
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-]\d{2}):\d{2}/.exec(tz ?? "");
  // Fallback to CET (+1) if parsing fails; CEST correction happens on next tick.
  return match ? Number(match[1]) : 1;
}

function nextScheduledTime(now: Date = new Date()): Date {
  const offset = amsterdamOffsetHours(now);
  const targetUTCHour = SCHEDULE_HOUR_AMSTERDAM - offset;
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUTCHour, 0, 0, 0),
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function enqueueDailyScheduledRuns(): Promise<void> {
  const now = new Date();
  const dateFrom = isoDate(new Date(now.getTime() - WINDOW_DAYS_BEFORE * DAY_MS));
  const dateTo = isoDate(new Date(now.getTime() + WINDOW_DAYS_AFTER * DAY_MS));

  const sources = listRunnableCatalogSources();
  let enqueued = 0;
  let skipped = 0;

  for (const source of sources) {
    try {
      const existing = await findActiveRun({
        sourceKey: source.key,
        dateFrom,
        dateTo,
        executionMode: "full",
      });
      if (existing) {
        skipped += 1;
        continue;
      }

      await createRun({
        source_key: source.key,
        supplier: source.supplier,
        date_from: dateFrom,
        date_to: dateTo,
        trigger: "scheduled",
        execution_mode: "full",
        parent_run_id: undefined,
        projection_version: currentProjectionVersion(),
        derivation_version: currentDerivationVersion(),
        status: "queued",
      });
      enqueued += 1;
    } catch (error) {
      console.error(`[scheduler] failed to enqueue ${source.key}:`, error);
    }
  }

  console.log(
    `[scheduler] enqueued ${enqueued} runs (skipped ${skipped} already active) for window ${dateFrom}..${dateTo}`,
  );
}

function scheduleNextTick(): void {
  const next = nextScheduledTime();
  const delay = Math.max(0, next.getTime() - Date.now());
  console.log(
    `[scheduler] next tick at ${next.toISOString()} (in ${Math.round(delay / 60_000)} min)`,
  );
  setTimeout(async () => {
    try {
      await enqueueDailyScheduledRuns();
    } catch (error) {
      console.error("[scheduler] tick failed:", error);
    }
    scheduleNextTick();
  }, delay);
}

export function startScheduler(): void {
  if (Deno.env.get("WOOZI_SCHEDULER_ENABLED") !== "1") {
    console.log("[scheduler] disabled (set WOOZI_SCHEDULER_ENABLED=1 to enable)");
    return;
  }
  console.log(
    `[scheduler] enabled — daily at 0${SCHEDULE_HOUR_AMSTERDAM}:00 Europe/Amsterdam, window ` +
      `-${WINDOW_DAYS_BEFORE}..+${WINDOW_DAYS_AFTER} days`,
  );
  scheduleNextTick();
}

export const __test__ = {
  nextScheduledTime,
  isoDate,
};
