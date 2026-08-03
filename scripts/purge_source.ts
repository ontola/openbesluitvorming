// Remove everything a source ever produced, so it can start over clean.
//
// Usage:
//   deno run -A scripts/purge_source.ts [--apply] [--quickwit] [--keep-storage] <sourceKey>
//
// Without --apply this is a dry run: it counts what would go and touches
// nothing.
//
// Written for a source that imported the wrong site — waterschap_limburg
// carried the province's sitename, so ~100k provincial entities sat in the
// index under a water board id. Correcting the catalog does not undo that: the
// corrected import produces different entity ids, so the wrong entities are
// never overwritten and would linger forever.
//
// Three stores hold the data and they have to be handled separately:
//
//   1. The export log — tombstones. This is the one that matters most for
//      reusers: the feed's contract is "follow the changes and you stay
//      correct", so records that simply stop appearing would leave every
//      downstream copy wrong forever. recordDelete both notifies them and
//      flips export_entity_state, which drops the entity from the snapshot.
//   2. Object storage — the source's own prefix. Keys embed supplier,
//      organization type and source key, so one source's objects can never
//      overlap another's.
//   3. Quickwit — optional (--quickwit). If a projection reindex is coming,
//      skipping the source there removes it for free: whatever is not
//      re-projected does not exist in the new index. Pass --quickwit to submit
//      a delete-by-query when you cannot wait for that.
import { getExportLog } from "../src/exports/log.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { getSource } from "../src/sources/index.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";
import type { ExportChangeRecord } from "../src/types.ts";

const PAGE_SIZE = 500;

function hasFlag(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}

/** Every live entity of a source, read straight from the export log. */
async function collectEntities(sourceKey: string): Promise<ExportChangeRecord[]> {
  const log = await getExportLog();
  const records: ExportChangeRecord[] = [];
  let cursor: string | null = null;

  while (true) {
    const page = log.readSnapshot(sourceKey, { cursor, limit: PAGE_SIZE });
    records.push(...page.records);
    if (!page.hasMore) {
      return records;
    }
    cursor = page.nextCursor;
  }
}

function countByType(records: ExportChangeRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.entity_type] = (counts[record.entity_type] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  const sourceKey = Deno.args.find((arg) => !arg.startsWith("--"));
  if (!sourceKey) {
    console.error("Usage: purge_source.ts [--apply] [--quickwit] [--keep-storage] <sourceKey>");
    Deno.exit(1);
  }

  // Resolves through the catalog, so a typo fails here rather than silently
  // purging nothing.
  const source = getSource(sourceKey);
  const apply = hasFlag("apply");
  const purgeQuickwit = hasFlag("quickwit");
  const keepStorage = hasFlag("keep-storage");

  console.log(`source:   ${source.key} (${source.supplier}, ${source.organizationType})`);
  console.log(`mode:     ${apply ? "APPLY — this deletes data" : "dry run"}`);

  const records = await collectEntities(source.key);
  const counts = countByType(records);
  console.log(`\nexport log: ${records.length} live entities`);
  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(14)} ${count}`);
  }

  const storagePrefix = `documents/${source.supplier}/${source.organizationType}/${source.key}/`;
  const storage = await ObjectStorageClient.fromEnvironment();
  console.log(`\nobject storage prefix: ${storagePrefix}`);
  if (!storage) {
    console.log("  (no object storage configured — skipping)");
  }

  const deleteQuery = `source_key:"${source.key}"`;
  console.log(`quickwit: ${purgeQuickwit ? `delete-by-query ${deleteQuery}` : "left alone (pass --quickwit)"}`);

  if (!apply) {
    console.log("\nDry run — nothing changed. Re-run with --apply to execute.");
    return;
  }

  // 1. Tombstones first. If the run dies halfway, downstream consumers have
  //    been told about the entities we already removed rather than silently
  //    losing them.
  const log = await getExportLog();
  let tombstones = 0;
  for (const record of records) {
    const appended = log.recordDelete({
      sourceKey: source.key,
      supplier: record.supplier,
      entityId: record.entity_id,
      entityType: record.entity_type,
    });
    if (appended) {
      tombstones += 1;
    }
  }
  await log.flush(source.key);
  console.log(`\ntombstones recorded: ${tombstones}`);

  // 2. Object storage. The store 504s under a long delete run, and an
  //    exception here used to skip step 3 entirely — a flaky bucket must not
  //    decide whether the index gets cleaned. Retry, then carry on regardless
  //    and report honestly at the end.
  let storageComplete = true;
  if (storage && !keepStorage) {
    let deletedTotal = 0;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const deleted = await storage.deleteByPrefix(storagePrefix);
        deletedTotal += deleted.length;
        if (deleted.length === 0) {
          break;
        }
        // deleteByPrefix returns once the prefix is empty; a non-empty result
        // that did not throw means it finished this pass.
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  storage delete attempt ${attempt}/5 failed: ${message.slice(0, 120)}`);
        if (attempt === 5) {
          storageComplete = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
      }
    }
    console.log(
      `objects deleted:     ${deletedTotal}${storageComplete ? "" : " (INCOMPLETE — re-run to finish)"}`,
    );
  } else {
    console.log("objects deleted:     skipped");
  }

  // 3. Quickwit, only on request — and independent of how storage went.
  if (purgeQuickwit) {
    await new QuickwitClient().createDeleteTask(deleteQuery);
    console.log("quickwit delete task submitted (applied during the next merge)");
  }

  console.log(
    `\nDone. Re-import with a normal full run; the source now starts from an empty state.`,
  );

  if (!storageComplete) {
    console.log("Storage was not fully cleared. Re-running is safe: every step is idempotent.");
    Deno.exit(2);
  }
}

if (import.meta.main) {
  await main();
}

export const __test__ = { collectEntities, countByType };
