// Permanently remove documents and block their re-ingest (takedowns, e.g. a
// BSN report).
//
// Shared by `scripts/delete_document.ts` (CLI) and the ops endpoint's
// `delete_document` action. For each document entity id
// (document:{supplier}:{orgType}:{source}:{nativeId}) it:
//   1. ingests op:"delete" marker documents into Quickwit for the document and
//      each of its DocumentPage children — the search API drops entities whose
//      newest doc is a delete marker, so the document disappears immediately;
//   2. creates a Quickwit delete task (delete-by-query on entity_id and
//      parent_entity_id) so all copies, including the markers, are removed
//      physically during merges;
//   3. deletes every S3 object under the document prefix (original file,
//      extracted markdown, page chunks, all versions) and its thumbnails;
//   4. records a delete tombstone in the export changes log so downstream
//      consumers drop the document too;
//   5. adds the entity id to the document blocklist so future imports skip it.
import { type ExportChangesLog, getExportLog } from "../exports/log.ts";
import { addDocumentToBlocklist } from "./store.ts";
import { currentProjectionVersion } from "../pipeline/versioning.ts";
import { QuickwitClient } from "../quickwit/client.ts";
import type { QuickwitSearchDocument } from "../quickwit/project.ts";
import { ObjectStorageClient } from "../storage/s3.ts";

export interface ParsedEntityId {
  entityId: string;
  supplier: string;
  organizationType: string;
  sourceKey: string;
  nativeId: string;
}

export function parseDocumentEntityId(entityId: string): ParsedEntityId {
  const parts = entityId.split(":");
  if (parts.length < 5 || parts[0] !== "document" || parts.slice(1, 5).some((part) => !part)) {
    throw new Error(
      `Not a document entity id (expected document:supplier:orgType:source:nativeId): ${entityId}`,
    );
  }
  return {
    entityId,
    supplier: parts[1],
    organizationType: parts[2],
    sourceKey: parts[3],
    nativeId: parts.slice(4).join(":"),
  };
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

type DeleteMarkerKind = "takedown" | "removed_at_source";

function deleteMarker(
  entityId: string,
  parentId: string | null,
  kind: DeleteMarkerKind = "takedown",
): QuickwitSearchDocument {
  const now = new Date().toISOString();
  return {
    time: now,
    event_id: `${kind}:${entityId}:${now}`,
    event_type: `nl.openbesluitvorming.entity.${kind}`,
    source: kind,
    subject: entityId,
    entity_id: entityId,
    entity_type: parentId ? "DocumentPage" : "Document",
    commit_id: `commit:${entityId}:${kind}`,
    op: "delete",
    mode: kind,
    schema_name: "Document",
    schema_version: "0",
    content_hash: kind,
    projection_version: currentProjectionVersion(),
    ...(parentId ? { parent_entity_id: parentId } : {}),
    payload: null,
  };
}

/** Every object storage prefix holding something derived from the document:
 * the original file, extracted markdown, page chunks and rendered pages. */
function documentStoragePrefixes(parsed: ParsedEntityId): string[] {
  const { entityId } = parsed;
  return [
    `documents/${parsed.supplier}/${parsed.organizationType}/${parsed.sourceKey}/${parsed.nativeId}/`,
    // objectKey falls back to the full entity id when the source did not set
    // a canonical_id.
    `documents/${parsed.supplier}/${parsed.organizationType}/${parsed.sourceKey}/${entityId}/`,
    `pdf-pages-v4/${entityId}/`,
    `pdf-pages-v2/${entityId}/`,
  ];
}

async function collectPageEntityIds(
  quickwit: QuickwitClient,
  entityId: string,
): Promise<{ pageIds: string[]; totalHits: number }> {
  const response = await quickwit.searchRequest({
    query: `entity_id:${quote(entityId)} OR parent_entity_id:${quote(entityId)}`,
    max_hits: 10_000,
  });
  const pageIds = new Set<string>();
  for (const hit of response.hits) {
    const hitEntityId = typeof hit.entity_id === "string" ? hit.entity_id : "";
    if (hitEntityId && hitEntityId !== entityId) {
      pageIds.add(hitEntityId);
    }
  }
  return { pageIds: [...pageIds], totalHits: response.num_hits };
}

async function deleteOne(
  parsed: ParsedEntityId,
  options: {
    apply: boolean;
    reason: string;
    quickwit: QuickwitClient;
    storage: ObjectStorageClient;
  },
  log: (line: string) => void,
): Promise<void> {
  const { entityId } = parsed;
  const prefixes = documentStoragePrefixes(parsed);

  const { pageIds, totalHits } = await collectPageEntityIds(options.quickwit, entityId);
  const s3Counts: Array<{ prefix: string; count: number }> = [];
  for (const prefix of prefixes) {
    const { keys, isTruncated } = await options.storage.listObjects({ prefix, maxKeys: 1000 });
    s3Counts.push({ prefix, count: keys.length + (isTruncated ? 1000 : 0) });
  }

  log(`\n${entityId}`);
  log(`  quickwit: ${totalHits} docs (${pageIds.length} page entity ids)`);
  for (const { prefix, count } of s3Counts) {
    if (count > 0) {
      log(`  s3: ${count} objects under ${prefix}`);
    }
  }
  if (totalHits === 0 && s3Counts.every((entry) => entry.count === 0)) {
    log("  nothing found (already deleted?)");
  }

  if (!options.apply) {
    return;
  }

  // 1. Delete markers: hide from search immediately (newest doc per entity_id
  //    wins the read-side dedupe and op:"delete" is then filtered out).
  const markers = [
    deleteMarker(entityId, null),
    ...pageIds.map((pageId) => deleteMarker(pageId, entityId)),
  ];
  await options.quickwit.ingestDocuments(markers);
  log(`  ingested ${markers.length} delete markers`);

  // 2. Physical removal of all copies (and eventually the markers) at merge
  //    time.
  await options.quickwit.createDeleteTask(
    `entity_id:${quote(entityId)} OR parent_entity_id:${quote(entityId)}`,
  );
  log("  created quickwit delete task");

  // 3. S3 artifacts, all versions.
  for (const prefix of prefixes) {
    const deleted = await options.storage.deleteByPrefix(prefix);
    if (deleted.length > 0) {
      log(`  deleted ${deleted.length} S3 objects under ${prefix}`);
    }
  }

  // 4. Export tombstone for downstream consumers.
  const exportLog = await getExportLog();
  const tombstone = exportLog.recordDelete({
    sourceKey: parsed.sourceKey,
    supplier: parsed.supplier,
    entityId,
    entityType: "Document",
  });
  await exportLog.flush(parsed.sourceKey);
  log(tombstone ? "  recorded export tombstone" : "  export tombstone skipped (never exported)");

  // 5. Never again.
  await addDocumentToBlocklist(entityId, options.reason);
  log(`  blocklisted (reason: ${options.reason})`);
}

export interface DeleteDocumentsResult {
  inspected: number;
  failures: number;
}

/** Inspect (dry run) or delete each document. A failure on one document is
 * logged and counted; the others still run. */
export async function deleteDocuments(
  entityIds: string[],
  options: { apply: boolean; reason: string },
  log: (line: string) => void,
  errorLog: (line: string) => void = log,
): Promise<DeleteDocumentsResult> {
  log(
    `${options.apply ? "DELETING" : "DRY RUN (pass --apply to delete)"}: ${entityIds.length} document(s)`,
  );

  const quickwit = new QuickwitClient();
  const storage = await ObjectStorageClient.fromEnvironment();
  let failures = 0;
  for (const entityId of entityIds) {
    try {
      await deleteOne(
        parseDocumentEntityId(entityId),
        { apply: options.apply, reason: options.reason, quickwit, storage },
        log,
      );
    } catch (error) {
      failures += 1;
      errorLog(`[error] ${entityId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(
    `\n${options.apply ? "deleted" : "inspected"} ${entityIds.length - failures}/${entityIds.length}`,
  );
  return { inspected: entityIds.length, failures };
}

/**
 * Take documents out of search, storage and the export feed because their
 * source no longer lists them (see src/pipeline/source_removals.ts).
 *
 * The same steps as a takedown with one difference: nothing is blocklisted.
 * If the source publishes a document again, the next import brings it back
 * with a newer row; the delete task only reaches rows that exist when it is
 * created. All documents share one delete task, because each task makes
 * Quickwit rewrite the splits it matches.
 */
export async function retractDocumentsGoneAtSource(
  entityIds: string[],
  options: {
    quickwit: QuickwitClient;
    storage: ObjectStorageClient;
    exportLog: { recordDelete: ExportChangesLog["recordDelete"] };
  },
): Promise<void> {
  if (entityIds.length === 0) {
    return;
  }
  const parsed = entityIds.map(parseDocumentEntityId);
  const markers: QuickwitSearchDocument[] = [];
  for (const { entityId } of parsed) {
    const { pageIds } = await collectPageEntityIds(options.quickwit, entityId);
    markers.push(
      deleteMarker(entityId, null, "removed_at_source"),
      ...pageIds.map((pageId) => deleteMarker(pageId, entityId, "removed_at_source")),
    );
  }
  await options.quickwit.ingestDocuments(markers);
  await options.quickwit.createDeleteTask(
    parsed
      .map(({ entityId }) => `entity_id:${quote(entityId)} OR parent_entity_id:${quote(entityId)}`)
      .join(" OR "),
  );
  for (const entry of parsed) {
    for (const prefix of documentStoragePrefixes(entry)) {
      await options.storage.deleteByPrefix(prefix);
    }
    options.exportLog.recordDelete({
      sourceKey: entry.sourceKey,
      supplier: entry.supplier,
      entityId: entry.entityId,
      entityType: "Document",
    });
  }
}
