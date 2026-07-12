import { DatabaseSync } from "node:sqlite";
import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import {
  EXPORT_BATCH_LIMIT_MAX,
  ExportChangesLog,
  type ExportSegmentStorage,
  parseChangesCursor,
} from "../src/exports/log.ts";
import type { DocumentEntity, ExportChangeRecord } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\n  expected: ${expectedJson}\n  actual:   ${actualJson}`);
  }
}

class FakeStorage implements ExportSegmentStorage {
  readonly objects = new Map<string, string>();
  putCount = 0;
  failNextPut = false;

  putObject(key: string, body: Uint8Array): Promise<unknown> {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error("simulated S3 outage"));
    }
    this.putCount += 1;
    this.objects.set(key, new TextDecoder().decode(body));
    return Promise.resolve({});
  }

  getObjectText(key: string): Promise<string> {
    return Promise.resolve(this.objects.get(key) ?? "");
  }
}

function makeLog(): { log: ExportChangesLog; storage: FakeStorage } {
  const storage = new FakeStorage();
  const log = new ExportChangesLog({ db: new DatabaseSync(":memory:"), storage });
  return { log, storage };
}

function makeDocument(options: {
  sourceKey?: string;
  nativeId: string;
  name?: string;
  markdown?: string[];
}): DocumentEntity {
  const sourceKey = options.sourceKey ?? "soest";
  return {
    id: `document:notubiz:gemeente:${sourceKey}:${options.nativeId}`,
    type: "Document",
    name: options.name ?? `Document ${options.nativeId}`,
    classification: ["Raadsvoorstel"],
    original_url: `https://api.notubiz.nl/document/${options.nativeId}/1`,
    file_name: `document-${options.nativeId}.pdf`,
    content_type: "application/pdf",
    last_discussed_at: "2024-11-07T00:00:00+01:00",
    organization: `organization:nl:gemeente:${sourceKey}`,
    md_text: options.markdown ?? ["# Inhoud\n\nVolledige tekst die niet in de log hoort."],
    source_info: {
      supplier: "notubiz",
      source: sourceKey,
      organization_type: "gemeente",
      canonical_id: options.nativeId,
    },
    raw: { id: options.nativeId },
  };
}

async function commit(
  log: ExportChangesLog,
  document: DocumentEntity,
  time = "2026-07-10T12:00:00.000Z",
): Promise<ExportChangeRecord | null> {
  const event = await buildEntityCommitEvent(document, { time });
  return log.recordCommit(event);
}

Deno.test("recordCommit assigns per-source monotonic sequence numbers", async () => {
  const { log } = makeLog();

  const first = await commit(log, makeDocument({ nativeId: "1" }));
  const second = await commit(log, makeDocument({ nativeId: "2" }));
  const otherSource = await commit(log, makeDocument({ sourceKey: "haarlem", nativeId: "9" }));

  assertEquals(first?.seq, 0, "first record starts at seq 0");
  assertEquals(second?.seq, 1, "second record increments seq");
  assertEquals(otherSource?.seq, 0, "sources have independent sequences");
});

Deno.test("recordCommit dedupes unchanged content and records real changes", async () => {
  const { log } = makeLog();
  const document = makeDocument({ nativeId: "1" });

  const first = await commit(log, document);
  const reingest = await commit(log, document, "2026-07-11T09:00:00.000Z");
  const changed = await commit(log, { ...document, name: "Gewijzigde titel" });

  assert(first, "first commit is recorded");
  assertEquals(reingest, null, "re-ingesting identical content appends nothing");
  assert(changed, "changed content is recorded");
  assertEquals(changed.seq, 1, "changed content gets the next seq");
  assert(changed.content_hash !== first.content_hash, "content hash reflects the change");

  const page = await log.readChanges("soest");
  assertEquals(page.records.length, 2, "log contains exactly the two real changes");
});

Deno.test("recorded payload is compact: no md_text, raw, or page_chunks", async () => {
  const { log } = makeLog();
  const record = await commit(log, makeDocument({ nativeId: "1" }));

  assert(record, "commit is recorded");
  const payload = record.payload as Record<string, unknown>;
  assert(payload, "record carries a payload");
  assertEquals(payload.name, "Document 1", "payload keeps compact fields");
  assert(!("md_text" in payload), "payload must not inline full markdown");
  assert(!("page_chunks" in payload), "payload must not inline page chunks");
  assert(!("raw" in payload), "payload must not inline raw source data");
});

Deno.test("recordDelete writes a tombstone once and revives on re-upsert", async () => {
  const { log } = makeLog();
  const document = makeDocument({ nativeId: "1" });
  await commit(log, document);

  const unknownDelete = log.recordDelete({
    sourceKey: "soest",
    supplier: "notubiz",
    entityId: "document:notubiz:gemeente:soest:404",
    entityType: "Document",
    time: "2026-07-10T13:00:00.000Z",
  });
  assertEquals(unknownDelete, null, "deleting a never-seen entity appends nothing");

  const tombstone = log.recordDelete({
    sourceKey: "soest",
    supplier: "notubiz",
    entityId: document.id,
    entityType: "Document",
    time: "2026-07-10T13:00:00.000Z",
  });
  assert(tombstone, "delete of a known entity is recorded");
  assertEquals(tombstone.op, "delete", "tombstone has op delete");
  assertEquals(tombstone.payload, undefined, "tombstone carries no payload");

  const repeated = log.recordDelete({
    sourceKey: "soest",
    supplier: "notubiz",
    entityId: document.id,
    entityType: "Document",
  });
  assertEquals(repeated, null, "repeated delete appends nothing");

  const revived = await commit(log, document, "2026-07-12T09:00:00.000Z");
  assert(revived, "re-upsert after delete is recorded even with identical content");

  const snapshot = log.readSnapshot("soest");
  assertEquals(snapshot.records.length, 1, "revived entity is back in the snapshot");
});

Deno.test("flush publishes pending records as one NDJSON segment", async () => {
  const { log, storage } = makeLog();
  await commit(log, makeDocument({ nativeId: "1" }));
  await commit(log, makeDocument({ nativeId: "2" }));

  const flushed = await log.flush("soest");
  assertEquals(flushed.recordCount, 2, "flush reports the published record count");
  assertEquals(
    flushed.objectKey,
    "exports/soest/changes/000000000000-000000000001.ndjson",
    "segment key encodes the seq range",
  );

  const body = storage.objects.get(flushed.objectKey ?? "");
  assert(body, "segment object exists in storage");
  const lines = body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ExportChangeRecord);
  assertEquals(
    lines.map((line) => line.seq),
    [0, 1],
    "segment lines are ordered by seq",
  );

  const emptyFlush = await log.flush("soest");
  assertEquals(emptyFlush.recordCount, 0, "flushing with nothing pending is a no-op");
  assertEquals(storage.putCount, 1, "no-op flush writes no object");
});

Deno.test("readChanges pages across segments and the pending tail", async () => {
  const { log } = makeLog();
  await commit(log, makeDocument({ nativeId: "1" }));
  await commit(log, makeDocument({ nativeId: "2" }));
  await log.flush("soest");
  await commit(log, makeDocument({ nativeId: "3" }));
  await commit(log, makeDocument({ nativeId: "4" }));
  await log.flush("soest");
  await commit(log, makeDocument({ nativeId: "5" }));

  const all = await log.readChanges("soest");
  assertEquals(
    all.records.map((record) => record.seq),
    [0, 1, 2, 3, 4],
    "reads across both segments plus the unflushed pending tail",
  );
  assertEquals(all.nextCursor, "5", "nextCursor points past the last record");
  assertEquals(all.hasMore, false, "log is exhausted");

  const firstPage = await log.readChanges("soest", { limit: 2 });
  assertEquals(
    firstPage.records.map((record) => record.seq),
    [0, 1],
    "limit bounds the page",
  );
  assertEquals(firstPage.hasMore, true, "more records remain");

  const secondPage = await log.readChanges("soest", { cursor: firstPage.nextCursor, limit: 2 });
  assertEquals(
    secondPage.records.map((record) => record.seq),
    [2, 3],
    "cursor resumes mid-log, spanning a segment boundary",
  );

  const lastPage = await log.readChanges("soest", { cursor: secondPage.nextCursor, limit: 2 });
  assertEquals(
    lastPage.records.map((record) => record.seq),
    [4],
    "final page serves the pending tail",
  );
  assertEquals(lastPage.hasMore, false, "pagination terminates");

  const beyond = await log.readChanges("soest", { cursor: lastPage.nextCursor });
  assertEquals(beyond.records.length, 0, "cursor at head returns an empty page");
  assertEquals(beyond.nextCursor, lastPage.nextCursor, "cursor at head is stable");
  assertEquals(beyond.hasMore, false, "cursor at head reports no more records");
});

Deno.test("records survive a failed flush and are served from the pending tail", async () => {
  const { log, storage } = makeLog();
  await commit(log, makeDocument({ nativeId: "1" }));

  storage.failNextPut = true;
  let flushError: unknown;
  try {
    await log.flush("soest");
  } catch (error) {
    flushError = error;
  }
  assert(flushError, "flush propagates the storage failure");

  const page = await log.readChanges("soest");
  assertEquals(page.records.length, 1, "unflushed record is still readable");

  const retried = await log.flush("soest");
  assertEquals(retried.recordCount, 1, "next flush publishes the surviving record");
});

Deno.test("readSnapshot returns the latest state per entity with cursor paging", async () => {
  const { log } = makeLog();
  const first = makeDocument({ nativeId: "1" });
  await commit(log, first);
  await commit(log, makeDocument({ nativeId: "2" }));
  await commit(log, makeDocument({ nativeId: "3" }));
  await commit(log, { ...first, name: "Nieuwere versie" });
  log.recordDelete({
    sourceKey: "soest",
    supplier: "notubiz",
    entityId: "document:notubiz:gemeente:soest:2",
    entityType: "Document",
  });

  const firstPage = log.readSnapshot("soest", { limit: 1 });
  assertEquals(firstPage.records.length, 1, "limit bounds the snapshot page");
  assertEquals(firstPage.hasMore, true, "more snapshot entries remain");
  assertEquals(firstPage.changesCursor, "5", "changesCursor equals the log head");

  const secondPage = log.readSnapshot("soest", { cursor: firstPage.nextCursor, limit: 10 });
  assertEquals(secondPage.hasMore, false, "snapshot is exhausted");

  const entities = [...firstPage.records, ...secondPage.records];
  assertEquals(entities.length, 2, "tombstoned entity is excluded from the snapshot");
  const updated = entities.find(
    (record) => record.entity_id === "document:notubiz:gemeente:soest:1",
  );
  assertEquals(
    (updated?.payload as { name?: string } | undefined)?.name,
    "Nieuwere versie",
    "snapshot serves the latest version of an updated entity",
  );
});

Deno.test("readChanges and readSnapshot scope records to the requested source", async () => {
  const { log } = makeLog();
  await commit(log, makeDocument({ nativeId: "1" }));
  await commit(log, makeDocument({ sourceKey: "haarlem", nativeId: "1" }));
  await log.flush("soest");

  const soest = await log.readChanges("soest");
  assertEquals(soest.records.length, 1, "changes only include the requested source");
  assertEquals(soest.records[0].source_key, "soest", "record carries its source key");

  const haarlem = log.readSnapshot("haarlem");
  assertEquals(haarlem.records.length, 1, "snapshot only includes the requested source");

  const unknown = await log.readChanges("nergenshuizen");
  assertEquals(unknown.records.length, 0, "unknown source yields an empty page");
  assertEquals(unknown.hasMore, false, "unknown source reports no more records");
});

Deno.test("parseChangesCursor accepts prior nextCursor values and rejects garbage", () => {
  assertEquals(parseChangesCursor(null), 0, "missing cursor starts at the beginning");
  assertEquals(parseChangesCursor(""), 0, "empty cursor starts at the beginning");
  assertEquals(parseChangesCursor("42"), 42, "numeric cursor round-trips");

  for (const invalid of ["-1", "1.5", "abc", "1e3x"]) {
    let thrown = false;
    try {
      parseChangesCursor(invalid);
    } catch {
      thrown = true;
    }
    assert(thrown, `cursor "${invalid}" must be rejected`);
  }
});

Deno.test("limit is clamped to the documented maximum", async () => {
  const { log } = makeLog();
  for (let index = 0; index < 3; index += 1) {
    await commit(log, makeDocument({ nativeId: String(index) }));
  }

  const zeroLimit = await log.readChanges("soest", { limit: 0 });
  assertEquals(zeroLimit.records.length, 1, "limit below 1 is raised to 1");

  const hugeLimit = await log.readChanges("soest", { limit: EXPORT_BATCH_LIMIT_MAX * 10 });
  assertEquals(hugeLimit.records.length, 3, "oversized limit still returns everything available");
});
