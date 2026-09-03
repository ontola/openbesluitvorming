import type {
  DocumentEntity,
  DocumentPageChunk,
  EntityCommitEvent,
  ExportChangeRecord,
  ExtractionIssue,
  RecordingEntity,
  WooziEntity,
} from "../types.ts";
import type { ExportChangesLog } from "../exports/log.ts";
import type { ObjectStorageClient } from "../storage/s3.ts";
import type { QuickwitSearchDocument } from "../quickwit/project.ts";
import { projectEntityCommitToQuickwitDocuments } from "../quickwit/project.ts";
import { mapLimit } from "../util/map_limit.ts";
import { readTranscript } from "../recordings/storage.ts";

/** How many live entities to pull from the export log per page. */
const DEFAULT_PAGE_SIZE = 500;

/** Object-storage reads in flight while rehydrating.
 *
 * Deliberately modest: each rehydrated document holds its page chunks in memory
 * until the batch is flushed, and the worker runs with a 4 GB heap. Raise it
 * only with a memory measurement to match — the reindex is bounded by storage
 * latency, not by CPU, so the returns fall off well before the risk does. */
const DEFAULT_REHYDRATE_CONCURRENCY = 8;

export interface ReindexStats {
  entity_count: number;
  document_count: number;
  rehydrated_count: number;
  issue_count: number;
}

/** Rebuild a commit event from a stored export record.
 *
 * The export log keeps the latest `upsert` per entity, which is exactly the
 * state a projection should reflect. Only the fields the projection actually
 * reads are reconstructed — the full `SourceInfo` (canonical_iri and friends)
 * is not stored per record and is not projected either. */
function toCommitEvent(record: ExportChangeRecord): EntityCommitEvent<WooziEntity> {
  const commitId = record.commit_id ?? `commit:${record.entity_id}:reindex`;
  return {
    specversion: "1.0",
    type: "entity.commit",
    source: `/woozi/${record.supplier}/${record.source_key}`,
    id: commitId,
    time: record.time,
    subject: record.entity_id,
    datacontenttype: "application/json",
    data: {
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      commit_id: commitId,
      op: "upsert",
      mode: "replace",
      schema_name: record.entity_type,
      schema_version: record.schema_version ?? "v1alpha1",
      content_hash: record.content_hash ?? "",
      source: {
        supplier: record.supplier,
        source: record.source_key,
      },
      payload: record.payload as WooziEntity | undefined,
    },
  };
}

/** Read back what materializeDocument stored under `page_chunks_key`.
 *
 * It writes `JSON.stringify({ pages: pageChunks })` -- an object -- at both of
 * its write sites. This reader accepted only a bare array, so the check never
 * matched, page_chunks was never restored, and every reindexed document fell
 * through to the markdown fallback instead.
 *
 * Nothing failed visibly. The run reported those documents as rehydrated,
 * because the fallback genuinely succeeded and the text was there. What
 * disappeared were the per-page rows built from page_chunks: measured on
 * zaltbommel, the reindexed index held 13,961 rows and not one DocumentPage,
 * against 106,334 of them in the live index. That costs page-level matching
 * and the jump to the page a hit was found on -- silently, across every
 * document, and only visible by counting rows afterwards (2026-08-12).
 *
 * A bare array is still accepted, so an older object cannot become unreadable
 * on account of this fix. */
export function parseStoredPageChunks(raw: string): DocumentPageChunk[] | null {
  // Deliberately not caught: a stored object that will not parse is corruption,
  // and the caller reports it per record. Swallowing it here would turn that
  // into a silent fall back to markdown -- the same class of quiet degradation
  // this function exists to fix.
  const parsed: unknown = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    return parsed as DocumentPageChunk[];
  }

  const pages = (parsed as { pages?: unknown } | null)?.pages;
  return Array.isArray(pages) ? (pages as DocumentPageChunk[]) : null;
}

/** Put a document's extracted text back on the payload.
 *
 * Export records are compact by design: they carry `derived_content` keys
 * rather than the text itself. Without this the reindexed document would keep
 * its title and metadata but lose every word of its content — the search index
 * would look complete while answering almost nothing. */
async function rehydrateDocumentText(
  payload: DocumentEntity,
  storage: ObjectStorageClient | undefined,
): Promise<boolean> {
  const derived = payload.derived_content;
  if (!storage || !derived) {
    return false;
  }

  if (derived.page_chunks_key) {
    const raw = await storage.getObjectText(derived.page_chunks_key);
    if (raw) {
      const pages = parseStoredPageChunks(raw);
      if (pages) {
        payload.page_chunks = pages;
        return true;
      }
    }
  }

  if (derived.markdown_key) {
    const markdown = await storage.getObjectText(derived.markdown_key);
    if (markdown) {
      payload.md_text = [markdown];
      return true;
    }
  }

  return false;
}

/** Put a recording's transcript back on the payload.
 *
 * Same trap as documents, and easier to miss: `compactEntityPayload` leaves
 * `segments` out of the export record on purpose — a transcript is ~30 KB and
 * would be repeated in every stored hit — so a reindex would re-project the
 * recording with only its title, chapters and speakers. The spoken word, which
 * is the entire reason the entity exists, would silently disappear from search
 * while the row still looked fine. */
async function rehydrateTranscript(
  payload: RecordingEntity,
  storage: ObjectStorageClient | undefined,
): Promise<boolean> {
  const key = payload.derived_content?.transcript_key;
  if (!storage || !key) {
    return false;
  }

  const stored = await readTranscript(storage, key);
  if (!stored?.segments?.length) {
    return false;
  }

  payload.segments = stored.segments;
  // Chapters and speakers do survive compaction, but the stored timeline is
  // the one the segments were cut against; prefer it when it is there.
  payload.chapters = stored.chapters ?? payload.chapters;
  payload.speakers = stored.speakers ?? payload.speakers;
  return true;
}

/**
 * Re-project every live entity of a source into Quickwit, without touching the
 * supplier APIs.
 *
 * This is the "reindex" level from AGENTS.md, between a full import and a
 * cache-rederive: it answers projection changes (a new field, a new
 * `WOOZI_PROJECTION_VERSION`, a freshly created index) using the export log as
 * the source of truth. It cannot produce data that was never imported — a new
 * entity type still needs a real import first.
 */
export async function reindexSource(
  sourceKey: string,
  context: {
    exportLog: ExportChangesLog;
    storage: ObjectStorageClient | undefined;
    ingest: (documents: QuickwitSearchDocument[]) => Promise<void>;
    batchSize: number;
    onProgress?: (stats: ReindexStats) => Promise<void> | void;
    onIssue?: (issue: ExtractionIssue) => Promise<void> | void;
    pageSize?: number;
    rehydrateConcurrency?: number;
  },
): Promise<ReindexStats> {
  const pageSize = context.pageSize ?? DEFAULT_PAGE_SIZE;
  const concurrency = Math.max(
    1,
    context.rehydrateConcurrency ??
      Number(Deno.env.get("WOOZI_REINDEX_CONCURRENCY") ?? DEFAULT_REHYDRATE_CONCURRENCY),
  );
  const stats: ReindexStats = {
    entity_count: 0,
    document_count: 0,
    rehydrated_count: 0,
    issue_count: 0,
  };

  let cursor: string | null = null;
  let pending: QuickwitSearchDocument[] = [];
  // Flushes are serialised: rehydration finishes in whatever order object
  // storage answers, and each completion may want to flush, but Quickwit is
  // handed one batch at a time so the ingest side keeps its old shape.
  let flushing: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    flushing = flushing.then(async () => {
      if (pending.length === 0) {
        return;
      }
      const batch = pending;
      pending = [];
      await context.ingest(batch);
    });
    return flushing;
  };

  while (true) {
    const page = context.exportLog.readSnapshot(sourceKey, { cursor, limit: pageSize });

    // Rehydration is where a reindex spends its time — it is one object-storage
    // read per document, and 57% of live entities carry stored text. Doing that
    // one record at a time held a source to ~4 entities/second (measured on
    // zaltbommel, 7500 entities in 1988s), which puts Amsterdam's 193k entities
    // at ~14 hours on its own. A source cannot be split across workers, so that
    // single number was the floor for the whole reindex no matter how many
    // workers ran.
    //
    // The reads now go out in parallel; projecting and flushing stay in order
    // afterwards, so the batching and its memory behaviour are unchanged. The
    // slice is what bounds memory: a rehydrated document carries its page
    // chunks, so only `concurrency` of them are ever held beyond `pending`.
    // This used to walk the page in slices of `concurrency` records and wait
    // for the whole slice before projecting any of it, which made every slice
    // as slow as its slowest read. Measured 2026-09-03 against Hetzner: with a
    // few reads per hundred taking 6-60s, 96 documents took 152s that way.
    // Now every record of the page is in flight under the same limit and each
    // one is projected the moment its own read completes; a slow object delays
    // only itself. Memory is bounded the same way as before: at most
    // `concurrency` rehydrated documents exist beyond `pending`, because a
    // record is projected (and its text handed to `pending`) before the slot
    // is reused.
    await mapLimit(page.records, concurrency, async (record) => {
      let event: EntityCommitEvent<WooziEntity>;
      let isDocument = false;
      let rehydrated = false;
      try {
        event = toCommitEvent(record);
        const payload = event.data.payload;
        isDocument = payload?.type === "Document";

        if (payload?.type === "Document") {
          rehydrated = await rehydrateDocumentText(payload, context.storage);
        } else if (payload?.type === "Recording") {
          rehydrated = await rehydrateTranscript(payload, context.storage);
        }
      } catch (error) {
        stats.issue_count += 1;
        await context.onIssue?.({
          severity: "warning",
          step: "ingest_quickwit",
          entity_id: record.entity_id,
          message: `Reindex skipped ${record.entity_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }

      if (isDocument) {
        stats.document_count += 1;
      }
      if (rehydrated) {
        stats.rehydrated_count += 1;
      }

      pending.push(...projectEntityCommitToQuickwitDocuments(event));
      stats.entity_count += 1;

      // Documents carry their page chunks until the batch is flushed, so
      // flush on the projected-document count rather than the entity count.
      if (pending.length >= context.batchSize) {
        await flush();
      }
    });

    await context.onProgress?.(stats);

    if (!page.hasMore) {
      break;
    }
    cursor = page.nextCursor;
  }

  await flush();
  return stats;
}

export const __test__ = { toCommitEvent, rehydrateDocumentText, rehydrateTranscript };
