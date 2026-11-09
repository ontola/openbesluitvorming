// Correct iBabs meeting times that were stored as Dutch wall clock labelled
// UTC (#203).
//
// Usage:
//   deno run -A scripts/repair_ibabs_times.ts [--apply] [--before <iso>] [--project <types>] [<sourceKey> ...]
//
// Without source keys it walks every iBabs source in the catalog. Without
// --apply this is a dry run: it reports per source how many records it would
// correct, with a sample, and writes nothing.
//
// Until 2026-08-13 the iBabs normaliser appended `Z` to its bare readings, so
// a 19:30 meeting was stored as 19:30 UTC, an hour or two late. Every record
// no import has rewritten since still holds that value, which covers nearly
// all of iBabs before 2025. The value itself cannot tell old from new; the
// record's write time can (see src/pipeline/repair_ibabs_times.ts).
//
// With --apply, each corrected record is appended to the export log, so the
// change feed hands the fix to every consumer, and the record is projected
// into Quickwit again. The new row carries the repair's own time, so it wins
// `dedupeLatestIndexedHits` over the stale row instead of tying with it
// (AGENTS.md, on reindexing in place). Nothing is asked of iBabs.
//
// --project limits which repaired types go back into Quickwit, for example
// `--project Meeting`. Every repaired record still goes to the export log.
// Re-projecting a document rehydrates its text and appends all its page rows,
// which for the iBabs backlog is ~1.9M documents; leaving those to the next
// projection-version reindex keeps that load off a live index.
//
// Must run where the export log, object storage and Quickwit are reachable:
// on the server, inside the openbesluitvorming container.
import { getExportLog } from "../src/exports/log.ts";
import { listCatalogSources } from "../src/sources/catalog.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { projectExportRecords, type ReindexStats } from "../src/pipeline/reindex.ts";
import {
  IBABS_ZULU_STAMPING_ENDED_AT,
  repairIbabsTimes,
} from "../src/pipeline/repair_ibabs_times.ts";
import type { QuickwitSearchDocument } from "../src/quickwit/project.ts";

function argValue(name: string): string | null {
  const index = Deno.args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < Deno.args.length ? Deno.args[index + 1] : null;
}

async function main(): Promise<void> {
  const apply = Deno.args.includes("--apply");
  const before = argValue("before") ?? IBABS_ZULU_STAMPING_ENDED_AT;
  if (Number.isNaN(Date.parse(before))) {
    console.error(`--before is not a timestamp: ${before}`);
    Deno.exit(1);
  }
  const projectArg = argValue("project");
  const projectTypes = projectArg
    ? new Set(
        projectArg
          .split(",")
          .map((type) => type.trim())
          .filter(Boolean),
      )
    : null;
  const named = Deno.args.filter(
    (arg, index) =>
      !arg.startsWith("--") && !["--before", "--project"].includes(Deno.args[index - 1]),
  );
  const ibabsKeys = new Set(
    listCatalogSources()
      .filter((entry) => entry.supplier === "ibabs")
      .map((entry) => entry.key),
  );
  for (const key of named) {
    if (!ibabsKeys.has(key)) {
      console.error(`${key} is not an iBabs source in the catalog`);
      Deno.exit(1);
    }
  }
  const sourceKeys = named.length > 0 ? named : [...ibabsKeys].sort();

  const exportLog = await getExportLog();
  let quickwit: QuickwitClient | null = null;
  let storage: ObjectStorageClient | undefined;
  if (apply) {
    quickwit = new QuickwitClient();
    await quickwit.waitUntilReady();
    storage = await ObjectStorageClient.fromEnvironment();
  }
  const batchSize = Math.max(1, Number(Deno.env.get("QUICKWIT_BATCH_SIZE") ?? "64"));

  console.log(
    `${apply ? "APPLY" : "DRY RUN"}: ${sourceKeys.length} iBabs sources, records written before ${before}` +
      (projectTypes ? `, projecting only ${[...projectTypes].join(",")}` : ""),
  );

  let totalScanned = 0;
  let totalRepaired = 0;
  let totalIssues = 0;
  for (const sourceKey of sourceKeys) {
    const projection: ReindexStats = {
      entity_count: 0,
      document_count: 0,
      rehydrated_count: 0,
      issue_count: 0,
    };
    const stats = await repairIbabsTimes(sourceKey, {
      exportLog,
      apply,
      before,
      onRepaired: quickwit
        ? async (records) => {
            let pending: QuickwitSearchDocument[] = [];
            const flush = async () => {
              const batch = pending;
              pending = [];
              if (batch.length > 0) {
                await quickwit!.ingestDocuments(batch);
              }
            };
            // One record at a time keeps the flushes in order; the reads are
            // a few hundred per page at most.
            const toProject = projectTypes
              ? records.filter((record) => projectTypes.has(record.entity_type))
              : records;
            await projectExportRecords(toProject, {
              storage,
              concurrency: 1,
              stats: projection,
              onIssue: (issue) => console.warn(`  [issue] ${issue.message}`),
              emit: async (documents) => {
                pending.push(...documents);
                if (pending.length >= batchSize) {
                  await flush();
                }
              },
            });
            await flush();
          }
        : undefined,
    });
    totalScanned += stats.scanned;
    totalRepaired += stats.repaired;
    totalIssues += projection.issue_count;
    if (stats.repaired === 0) {
      continue;
    }
    const byType = Object.entries(stats.byType)
      .map(([type, count]) => `${type}=${count}`)
      .join(" ");
    console.log(
      `${sourceKey}: ${stats.repaired}/${stats.scanned} ${byType}` +
        (apply ? ` projected=${projection.entity_count} issues=${projection.issue_count}` : ""),
    );
    for (const sample of stats.samples) {
      const changes = sample.changes.map(
        (change) => `${change.field} ${change.from} -> ${change.to}`,
      );
      console.log(`  ${sample.record.entity_id}: ${changes.join(", ")}`);
    }
  }

  console.log(
    `total: ${totalRepaired} of ${totalScanned} live records ${apply ? "repaired" : "would be repaired"}` +
      (apply ? `, projection issues ${totalIssues}` : ""),
  );
  if (totalIssues > 0) {
    Deno.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
