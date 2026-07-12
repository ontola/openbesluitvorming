// Permanently removes documents from OpenBesluitvorming and blocks re-ingest.
//
// Usage:
//   deno run -A scripts/delete_document.ts [--apply] [--reason bsn] <entityId> [<entityId> ...]
//   deno run -A scripts/delete_document.ts [--apply] [--reason bsn] --findings bsn-findings.ndjson [--confidence high]
//
// Without --apply this is a dry run: it reports what would be deleted.
//
// For each document entity id (document:{supplier}:{orgType}:{source}:{nativeId}) it:
//   1. ingests op:"delete" marker documents into Quickwit for the document and
//      each of its DocumentPage children — the search API drops entities whose
//      newest doc is a delete marker, so the document disappears immediately;
//   2. creates a Quickwit delete task (delete-by-query on entity_id and
//      parent_entity_id) so the janitor physically removes all copies,
//      including the markers, during merges;
//   3. deletes every S3 object under the document prefix (original file,
//      extracted markdown, page chunks, all versions) and its thumbnails;
//   4. records a delete tombstone in the export changes log so downstream
//      consumers drop the document too;
//   5. adds the entity id to the document blocklist so future imports skip it.
//
// Must run where Quickwit ingest and the ops/export SQLite databases are
// reachable (on the server, e.g. inside the openbesluitvorming container).

import { getExportLog } from "../src/exports/log.ts";
import { addDocumentToBlocklist } from "../src/ops/store.ts";
import { currentProjectionVersion } from "../src/pipeline/versioning.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import type { QuickwitSearchDocument } from "../src/quickwit/project.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

interface ParsedEntityId {
  entityId: string;
  supplier: string;
  organizationType: string;
  sourceKey: string;
  nativeId: string;
}

function parseEntityId(entityId: string): ParsedEntityId {
  const parts = entityId.split(":");
  if (parts.length < 5 || parts[0] !== "document") {
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

function deleteMarker(entityId: string, parentId: string | null): QuickwitSearchDocument {
  const now = new Date().toISOString();
  return {
    time: now,
    event_id: `takedown:${entityId}:${now}`,
    event_type: "nl.openbesluitvorming.entity.takedown",
    source: "takedown",
    subject: entityId,
    entity_id: entityId,
    entity_type: parentId ? "DocumentPage" : "Document",
    commit_id: `commit:${entityId}:takedown`,
    op: "delete",
    mode: "takedown",
    schema_name: "Document",
    schema_version: "0",
    content_hash: "takedown",
    projection_version: currentProjectionVersion(),
    ...(parentId ? { parent_entity_id: parentId } : {}),
    payload: null,
  };
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
): Promise<void> {
  const { entityId } = parsed;
  const prefixes = [
    `documents/${parsed.supplier}/${parsed.organizationType}/${parsed.sourceKey}/${parsed.nativeId}/`,
    // objectKey falls back to the full entity id when the source did not set
    // a canonical_id.
    `documents/${parsed.supplier}/${parsed.organizationType}/${parsed.sourceKey}/${entityId}/`,
    `pdf-pages-v4/${entityId}/`,
    `pdf-pages-v2/${entityId}/`,
  ];

  const { pageIds, totalHits } = await collectPageEntityIds(options.quickwit, entityId);
  const s3Counts: Array<{ prefix: string; count: number }> = [];
  for (const prefix of prefixes) {
    const { keys, isTruncated } = await options.storage.listObjects({ prefix, maxKeys: 1000 });
    s3Counts.push({ prefix, count: keys.length + (isTruncated ? 1000 : 0) });
  }

  console.log(`\n${entityId}`);
  console.log(`  quickwit: ${totalHits} docs (${pageIds.length} page entity ids)`);
  for (const { prefix, count } of s3Counts) {
    if (count > 0) {
      console.log(`  s3: ${count} objects under ${prefix}`);
    }
  }
  if (totalHits === 0 && s3Counts.every((entry) => entry.count === 0)) {
    console.log("  nothing found (already deleted?)");
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
  console.log(`  ingested ${markers.length} delete markers`);

  // 2. Physical removal of all copies (and eventually the markers) by the
  //    janitor at merge time.
  await options.quickwit.createDeleteTask(
    `entity_id:${quote(entityId)} OR parent_entity_id:${quote(entityId)}`,
  );
  console.log("  created quickwit delete task");

  // 3. S3 artifacts, all versions.
  for (const prefix of prefixes) {
    const deleted = await options.storage.deleteByPrefix(prefix);
    if (deleted.length > 0) {
      console.log(`  deleted ${deleted.length} S3 objects under ${prefix}`);
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
  console.log(
    tombstone ? "  recorded export tombstone" : "  export tombstone skipped (never exported)",
  );

  // 5. Never again.
  await addDocumentToBlocklist(entityId, options.reason);
  console.log(`  blocklisted (reason: ${options.reason})`);
}

function argValue(name: string): string | null {
  const index = Deno.args.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < Deno.args.length) {
    return Deno.args[index + 1];
  }
  return null;
}

async function main(): Promise<void> {
  const apply = Deno.args.includes("--apply");
  const reason = argValue("reason") ?? "takedown";
  const findingsPath = argValue("findings");
  const confidenceFilter = argValue("confidence");

  const entityIds = new Set<string>();
  if (findingsPath) {
    const text = await Deno.readTextFile(findingsPath);
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const finding = JSON.parse(line) as { entityId?: string | null; confidence?: string };
      if (!finding.entityId) {
        console.warn(`[warning] finding without entityId skipped: ${line.slice(0, 120)}`);
        continue;
      }
      if (confidenceFilter && finding.confidence !== confidenceFilter) {
        continue;
      }
      entityIds.add(finding.entityId);
    }
  }
  for (const arg of Deno.args) {
    if (arg.startsWith("document:")) {
      entityIds.add(arg);
    }
  }

  if (entityIds.size === 0) {
    console.error(
      "Usage: delete_document.ts [--apply] [--reason <reason>] (<entityId> ... | --findings <file.ndjson> [--confidence high])",
    );
    Deno.exit(1);
  }

  console.log(
    `${apply ? "DELETING" : "DRY RUN (pass --apply to delete)"}: ${entityIds.size} document(s)`,
  );

  const quickwit = new QuickwitClient();
  const storage = await ObjectStorageClient.fromEnvironment();
  let failures = 0;
  for (const entityId of entityIds) {
    try {
      await deleteOne(parseEntityId(entityId), { apply, reason, quickwit, storage });
    } catch (error) {
      failures += 1;
      console.error(
        `[error] ${entityId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\n${apply ? "deleted" : "inspected"} ${entityIds.size - failures}/${entityIds.size}`);
  if (failures > 0) {
    Deno.exit(1);
  }
}

await main();
