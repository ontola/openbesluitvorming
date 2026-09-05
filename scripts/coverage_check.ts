/**
 * Coverage check: compare what each supplier lists against what we hold.
 *
 * For every runnable source (or one, with --source), list the document ids
 * the supplier's API exposes for the window and compare them with the
 * document ids in the export log. The result lands in the ops store
 * (`coverage_check`) and from there in `/api/status` as `coverage` per
 * source. Nothing is downloaded and nothing is imported.
 *
 * Usage:
 *   deno run -A scripts/coverage_check.ts                    # every source, last 12 months
 *   deno run -A scripts/coverage_check.ts --months 6
 *   deno run -A scripts/coverage_check.ts --source ermelo
 *   deno run -A scripts/coverage_check.ts --supplier notubiz
 *   deno run -A scripts/coverage_check.ts --dry-run          # print, do not record
 *
 * Runs weekly on production from a systemd timer
 * (scripts/install-production-coverage.sh). It shares the suppliers' request
 * budgets with the nightly import -- iBabs is paced by the same fleet-wide
 * limiter -- which is why it runs on a quiet morning and one source at a
 * time.
 */
import { parseArgs } from "node:util";
import { compareCoverage, listSupplierDocuments } from "../src/coverage/check.ts";
import { getExportLog } from "../src/exports/log.ts";
import { recordCoverageCheck } from "../src/ops/store.ts";
import { listRunnableCatalogSources, listSources } from "../src/sources/index.ts";

const args = parseArgs({
  args: Deno.args,
  options: {
    source: { type: "string" },
    supplier: { type: "string" },
    months: { type: "string", default: "12" },
    "dry-run": { type: "boolean", default: false },
  },
}).values;

const months = Number(args.months);
if (!Number.isInteger(months) || months <= 0) {
  console.error(`--months must be a positive integer, got ${JSON.stringify(args.months)}`);
  Deno.exit(1);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const now = new Date();
const from = new Date(now);
from.setUTCMonth(from.getUTCMonth() - months);
const windowFrom = isoDate(from);
const windowTo = isoDate(now);

const runnable = new Set(listRunnableCatalogSources().map((entry) => entry.key));
const sources = listSources().filter(
  (source) =>
    runnable.has(source.key) &&
    (!args.source || source.key === args.source) &&
    (!args.supplier || source.supplier === args.supplier),
);
if (sources.length === 0) {
  console.error("No sources match.");
  Deno.exit(1);
}

const exportLog = await getExportLog();
console.log(
  `coverage check: ${sources.length} source(s), window ${windowFrom}..${windowTo}${
    args["dry-run"] ? " [dry-run]" : ""
  }`,
);

let checked = 0;
let failed = 0;
for (const source of sources) {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  try {
    const listing = await listSupplierDocuments(source, windowFrom, windowTo);
    const held = exportLog.listEntityIds(source.key, "document:");
    const comparison = compareCoverage(listing.documentIds, held);
    const ratio =
      comparison.supplierDocuments > 0
        ? comparison.heldDocuments / comparison.supplierDocuments
        : 1;
    console.log(
      `${source.key.padEnd(26)} supplier=${String(comparison.supplierDocuments).padStart(6)} ` +
        `held=${String(comparison.heldDocuments).padStart(6)} missing=${String(
          comparison.missingDocuments,
        ).padStart(6)} ` +
        `(${(ratio * 100).toFixed(1)}%) meetings=${listing.meetings} entries=${listing.registerEntries}` +
        `${listing.warnings.length > 0 ? ` warnings=${listing.warnings.length}` : ""} ` +
        `${Math.round((performance.now() - started) / 1000)}s`,
    );
    for (const warning of listing.warnings.slice(0, 3)) {
      console.log(`  warning: ${warning}`);
    }
    if (!args["dry-run"]) {
      await recordCoverageCheck({
        source_key: source.key,
        checked_at: checkedAt,
        window_from: windowFrom,
        window_to: windowTo,
        supplier_documents: comparison.supplierDocuments,
        held_documents: comparison.heldDocuments,
        missing_documents: comparison.missingDocuments,
        missing_sample: comparison.missingSample,
        supplier_meetings: listing.meetings,
        register_entries: listing.registerEntries,
        warnings: listing.warnings.length,
      });
    }
    checked += 1;
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`${source.key.padEnd(26)} FAILED: ${message.slice(0, 200)}`);
    if (!args["dry-run"]) {
      await recordCoverageCheck({
        source_key: source.key,
        checked_at: checkedAt,
        window_from: windowFrom,
        window_to: windowTo,
        supplier_documents: 0,
        held_documents: 0,
        missing_documents: 0,
        missing_sample: [],
        supplier_meetings: 0,
        register_entries: 0,
        warnings: 0,
        error: message.slice(0, 500),
      });
    }
  }
}
console.log(`done: ${checked} checked, ${failed} failed`);
