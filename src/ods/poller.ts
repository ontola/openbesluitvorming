/**
 * Polls the ODS feeds between nightly imports, so a meeting a griffie
 * publishes shows up within minutes instead of the next night.
 *
 * The check is cheap and changes nothing: one `GET /feed` with our saved
 * cursor and `limit=1`. Only when the feed has something new does it queue an
 * import, and that import (in the worker, src/ods/extractor.ts) reads the
 * feed, moves the cursor and emits every changed meeting whatever its date.
 * So the cursor has one writer, the worker, and this loop only reads it.
 *
 * Runs in the web container next to the daily scheduler, behind the same
 * WOOZI_SCHEDULER_ENABLED switch.
 */
import { createRun, findActiveRun } from "../ops/store.ts";
import { currentDerivationVersion, currentProjectionVersion } from "../pipeline/versioning.ts";
import { listRunnableCatalogSources } from "../sources/index.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import type { SourceCatalogEntry } from "../types.ts";
import { OdsFeedClient } from "./feed.ts";
import { type MirrorStorage, OdsMirror } from "./mirror.ts";
import { amsterdamDay } from "./normalize.ts";

const DEFAULT_POLL_SECONDS = 300;

export function odsPollSeconds(): number {
  const value = Number(Deno.env.get("WOOZI_ODS_POLL_SECONDS") ?? DEFAULT_POLL_SECONDS);
  return Number.isFinite(value) && value >= 30 ? value : DEFAULT_POLL_SECONDS;
}

export interface PollDeps {
  storage: () => Promise<MirrorStorage | undefined>;
  fetcher?: typeof fetch;
  findActiveRun: typeof findActiveRun;
  createRun: typeof createRun;
  now?: () => Date;
}

/** Whether the feed has records after our cursor. No cursor yet means the
 * snapshot is still to be read, which an import does. */
export async function feedHasNews(
  source: SourceCatalogEntry,
  storage: MirrorStorage,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const state = await new OdsMirror(storage, source.key).state();
  if (!state.cursor) return true;
  const client = new OdsFeedClient(source.odsFeedUrl!, source.organisatiecode!, fetcher);
  const page = await client.feed(state.cursor, 1);
  return page.records.length > 0;
}

/** One poll over every ODS source; returns the keys it queued an import for. */
export async function pollOdsFeeds(deps: PollDeps): Promise<string[]> {
  const sources = listRunnableCatalogSources().filter((source) => source.supplier === "ods");
  if (sources.length === 0) return [];
  const storage = await deps.storage();
  if (!storage) return [];
  const today = amsterdamDay((deps.now?.() ?? new Date()).toISOString());
  const queued: string[] = [];
  for (const source of sources) {
    try {
      if (!(await feedHasNews(source, storage, deps.fetcher))) continue;
      const active = await deps.findActiveRun({
        sourceKey: source.key,
        dateFrom: today,
        dateTo: today,
        executionMode: "full",
      });
      if (active) continue;
      await deps.createRun({
        source_key: source.key,
        supplier: source.supplier,
        date_from: today,
        date_to: today,
        trigger: "scheduled",
        execution_mode: "full",
        parent_run_id: undefined,
        projection_version: currentProjectionVersion(),
        derivation_version: currentDerivationVersion(),
        status: "queued",
      });
      queued.push(source.key);
    } catch (error) {
      console.warn(
        `[ods-poller] ${source.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (queued.length > 0) {
    console.log(`[ods-poller] queued imports for ${queued.join(", ")}`);
  }
  return queued;
}

export function startOdsPoller(): void {
  if (Deno.env.get("WOOZI_SCHEDULER_ENABLED") !== "1") return;
  const hasSources = listRunnableCatalogSources().some((source) => source.supplier === "ods");
  if (!hasSources) return;
  const seconds = odsPollSeconds();
  console.log(`[ods-poller] enabled, every ${seconds} s`);
  const tick = async () => {
    try {
      await pollOdsFeeds({
        storage: () => ObjectStorageClient.fromEnvironment(),
        findActiveRun,
        createRun,
      });
    } catch (error) {
      console.error("[ods-poller] tick failed:", error);
    }
    setTimeout(tick, seconds * 1000);
  };
  setTimeout(tick, seconds * 1000);
}
