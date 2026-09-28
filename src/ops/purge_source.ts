// Remove everything a source ever produced, so it can start over clean.
//
// Shared by `scripts/purge_source.ts` (CLI) and the ops endpoint's
// `purge_source` action. The script's header explains why each store is
// handled the way it is.
import { getExportLog } from "../exports/log.ts";
import { QuickwitClient } from "../quickwit/client.ts";
import { getProjectableSource } from "../sources/index.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import { sourceStoragePrefixes } from "../storage/prefixes.ts";
import type { ExportChangeRecord } from "../types.ts";

const PAGE_SIZE = 500;

export interface PurgeSourceOptions {
  apply: boolean;
  /** Also submit a Quickwit delete-by-query for the source. */
  quickwit: boolean;
  /** Leave the source's objects in object storage. */
  keepStorage: boolean;
}

export interface PurgeSourceResult {
  sourceKey: string;
  liveEntities: number;
  tombstones: number;
  objectsDeleted: number;
  /** False when object storage could not be fully cleared; re-running is
   * safe, every step is idempotent. */
  storageComplete: boolean;
}

/** Every live entity of a source, read straight from the export log. */
export async function collectEntities(sourceKey: string): Promise<ExportChangeRecord[]> {
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

export function countByType(records: ExportChangeRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.entity_type] = (counts[record.entity_type] ?? 0) + 1;
  }
  return counts;
}

export async function purgeSource(
  sourceKey: string,
  options: PurgeSourceOptions,
  log: (line: string) => void = console.log,
): Promise<PurgeSourceResult> {
  // Resolves through the catalog, so a typo fails here rather than silently
  // purging nothing. Through the projectable lookup, not the runnable one: a
  // source is switched off in the catalog before its data is removed, and
  // the runnable lookup refused exactly those (2026-09-10).
  const source = getProjectableSource(sourceKey);
  const { apply, keepStorage } = options;
  const purgeQuickwit = options.quickwit;

  log(`source:   ${source.key} (${source.supplier}, ${source.organizationType})`);
  log(`mode:     ${apply ? "APPLY — this deletes data" : "dry run"}`);

  const records = await collectEntities(source.key);
  const counts = countByType(records);
  log(`\nexport log: ${records.length} live entities`);
  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    log(`  ${type.padEnd(14)} ${count}`);
  }

  // Every prefix this source writes to. Recordings live under their own root,
  // so purging only `documents/` left a source's transcripts behind — text that
  // a purge or a takedown is supposed to remove.
  const storagePrefixes = sourceStoragePrefixes(source);
  const storage = await ObjectStorageClient.fromEnvironment();
  log(`\nobject storage prefixes:`);
  for (const prefix of storagePrefixes) {
    log(`  ${prefix}`);
  }
  if (!storage) {
    log("  (no object storage configured — skipping)");
  }

  const deleteQuery = `source_key:"${source.key}"`;
  log(
    `quickwit: ${purgeQuickwit ? `delete-by-query ${deleteQuery}` : "left alone (pass --quickwit)"}`,
  );

  const result: PurgeSourceResult = {
    sourceKey: source.key,
    liveEntities: records.length,
    tombstones: 0,
    objectsDeleted: 0,
    storageComplete: true,
  };

  if (!apply) {
    log("\nDry run — nothing changed. Re-run with --apply to execute.");
    return result;
  }

  // 1. Tombstones first. If the run dies halfway, downstream consumers have
  //    been told about the entities we already removed rather than silently
  //    losing them.
  const exportLog = await getExportLog();
  for (const record of records) {
    const appended = exportLog.recordDelete({
      sourceKey: source.key,
      supplier: record.supplier,
      entityId: record.entity_id,
      entityType: record.entity_type,
    });
    if (appended) {
      result.tombstones += 1;
    }
  }
  await exportLog.flush(source.key);
  log(`\ntombstones recorded: ${result.tombstones}`);

  // 2. Object storage. The store 504s under a long delete run, and an
  //    exception here used to skip step 3 entirely — a flaky bucket must not
  //    decide whether the index gets cleaned. Retry, then carry on regardless
  //    and report honestly at the end.
  if (storage && !keepStorage) {
    for (const storagePrefix of storagePrefixes) {
      // Each prefix retries on its own: a bucket that 504s while clearing
      // documents must not leave recordings untouched and unreported.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          const deleted = await storage.deleteByPrefix(storagePrefix);
          result.objectsDeleted += deleted.length;
          // deleteByPrefix returns once the prefix is empty; a result that did
          // not throw means it finished this pass.
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(
            `  storage delete attempt ${attempt}/5 failed for ${storagePrefix}: ${message.slice(
              0,
              120,
            )}`,
          );
          if (attempt === 5) {
            result.storageComplete = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
        }
      }
    }
    log(
      `objects deleted:     ${result.objectsDeleted}${result.storageComplete ? "" : " (INCOMPLETE — re-run to finish)"}`,
    );
  } else {
    log("objects deleted:     skipped");
  }

  // 3. Quickwit, only on request — and independent of how storage went.
  if (purgeQuickwit) {
    await new QuickwitClient().createDeleteTask(deleteQuery);
    log("quickwit delete task submitted (applied during the next merge)");
  }

  log(`\nDone. Re-import with a normal full run; the source now starts from an empty state.`);

  if (!result.storageComplete) {
    log("Storage was not fully cleared. Re-running is safe: every step is idempotent.");
  }
  return result;
}
