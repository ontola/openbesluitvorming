/**
 * Enqueue full-history imports for all runnable sources.
 *
 * Creates queued runs (picked up by the worker through the SQLite queue) that
 * cover a long historical window, chunked per source into fixed-size date
 * ranges — newest chunks first, so the recent gap closes before deep history.
 *
 * Runs are enqueued with trigger "scheduled": the daily scheduler pauses its
 * own enqueue while scheduled runs are queued/running, so the backfill and the
 * daily window never compete, and the daily rhythm resumes automatically when
 * the backfill drains.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   deno run -A scripts/enqueue_full_history.ts                # dry-run, all sources
 *   deno run -A scripts/enqueue_full_history.ts --apply
 *   deno run -A scripts/enqueue_full_history.ts --source soest --date-from 2010-01-01 --apply
 */

import { parseArgs } from "node:util";
import { createRun, findActiveRun } from "../src/ops/store.ts";
import { listRunnableCatalogSources } from "../src/sources/index.ts";
import { currentDerivationVersion, currentProjectionVersion } from "../src/pipeline/versioning.ts";

const { values: args } = parseArgs({
  args: Deno.args,
  options: {
    apply: { type: "boolean", default: false },
    source: { type: "string" },
    "date-from": { type: "string", default: "2002-01-01" },
    "date-to": { type: "string" },
    "chunk-months": { type: "string", default: "12" },
  },
});

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function assertIsoDate(value: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(value).getTime())) {
    console.error(`Invalid ${flag}: ${value} (expected YYYY-MM-DD)`);
    Deno.exit(1);
  }
  return value;
}

const dateFrom = assertIsoDate(args["date-from"] ?? "2002-01-01", "--date-from");
const dateTo = assertIsoDate(
  args["date-to"] ?? isoDate(new Date(Date.now() + 7 * 86_400_000)),
  "--date-to",
);
const chunkMonths = Math.max(1, Math.min(Number(args["chunk-months"]) || 12, 120));

/** Consecutive [from, to) chunks covering the window, newest first. */
function dateChunks(from: string, to: string, months: number): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let end = new Date(`${to}T00:00:00Z`);
  const floor = new Date(`${from}T00:00:00Z`);
  while (end > floor) {
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - months);
    const chunkStart = start > floor ? start : floor;
    chunks.push([isoDate(chunkStart), isoDate(end)]);
    end = chunkStart;
  }
  return chunks;
}

const sources = listRunnableCatalogSources().filter(
  (source) => !args.source || source.key === args.source,
);
if (sources.length === 0) {
  console.error(args.source ? `Unknown or non-runnable source: ${args.source}` : "No sources.");
  Deno.exit(1);
}

const chunks = dateChunks(dateFrom, dateTo, chunkMonths);
console.log(
  `${args.apply ? "Enqueueing" : "[dry-run] Would enqueue"} up to ` +
    `${sources.length} sources x ${chunks.length} chunks (${dateFrom}..${dateTo}, ` +
    `${chunkMonths}mo per chunk), newest chunks first.`,
);

let enqueued = 0;
let skipped = 0;

// Interleave: for each chunk (newest first), enqueue all sources. The worker
// claims in insertion order, so every source's recent history lands before any
// source's deep history.
for (const [chunkFrom, chunkTo] of chunks) {
  for (const source of sources) {
    const existing = await findActiveRun({
      sourceKey: source.key,
      dateFrom: chunkFrom,
      dateTo: chunkTo,
      executionMode: "full",
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    if (args.apply) {
      await createRun({
        source_key: source.key,
        supplier: source.supplier,
        date_from: chunkFrom,
        date_to: chunkTo,
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
}

console.log(
  `${args.apply ? "Enqueued" : "[dry-run] Would enqueue"} ${enqueued} runs ` +
    `(${skipped} skipped as already active).`,
);
