import {
  parseStoredPageChunks,
  reindexSource,
  __test__ as reindexTest,
} from "../src/pipeline/reindex.ts";
import type { ExportChangeRecord } from "../src/types.ts";
import type { QuickwitSearchDocument } from "../src/quickwit/project.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Stands in for the export log, paging like the real readSnapshot does. */
class FakeExportLog {
  readonly pageRequests: Array<string | null | undefined> = [];

  constructor(private readonly records: ExportChangeRecord[]) {}

  readSnapshot(_sourceKey: string, options: { cursor?: string | null; limit?: number }) {
    this.pageRequests.push(options.cursor);
    const after = options.cursor ?? "";
    const limit = options.limit ?? 500;
    const sorted = [...this.records].sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    const remaining = sorted.filter((record) => record.entity_id > after);
    const page = remaining.slice(0, limit);
    return {
      records: page,
      nextCursor: page.length > 0 ? page[page.length - 1].entity_id : after,
      hasMore: remaining.length > limit,
      changesCursor: "0",
    };
  }
}

class FakeStorage {
  readonly reads: string[] = [];
  /** Highest number of reads in flight at once, so a test can tell a parallel
   * rehydration from a sequential one. */
  peakConcurrency = 0;
  private inFlight = 0;
  private readonly delayMs: number;

  constructor(
    private readonly objects: Record<string, string>,
    delayMs = 0,
  ) {
    this.delayMs = delayMs;
  }

  async getObjectText(key: string): Promise<string> {
    this.reads.push(key);
    this.inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.inFlight);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.inFlight -= 1;
    return this.objects[key] ?? "";
  }
}

function meetingRecord(id: string): ExportChangeRecord {
  return {
    seq: 1,
    op: "upsert",
    time: "2026-01-29T10:00:00.000Z",
    entity_id: id,
    entity_type: "Meeting",
    source_key: "utrecht",
    supplier: "ibabs",
    commit_id: `commit:${id}:abc`,
    content_hash: "sha256:abc",
    payload: {
      type: "Meeting",
      name: "Gemeenteraad",
      classification: ["Agenda"],
      start_date: "2026-01-29T19:30:00Z",
      location: "Stadhuis",
      agenda: [{ id: `${id}:item-1`, title: "Programmabegroting" }],
    },
  };
}

function documentRecord(
  id: string,
  keys: { markdown?: string; chunks?: string },
): ExportChangeRecord {
  return {
    seq: 2,
    op: "upsert",
    time: "2026-01-29T10:00:00.000Z",
    entity_id: id,
    entity_type: "Document",
    source_key: "utrecht",
    supplier: "ibabs",
    commit_id: `commit:${id}:def`,
    content_hash: "sha256:def",
    payload: {
      type: "Document",
      name: "Raadsvoorstel",
      classification: ["Bijlage"],
      last_discussed_at: "2026-01-29T19:30:00Z",
      derived_content: {
        markdown_key: keys.markdown,
        page_chunks_key: keys.chunks,
        page_count: 2,
      },
    },
  };
}

Deno.test("a stored export record rebuilds into a projectable commit event", () => {
  const event = reindexTest.toCommitEvent(meetingRecord("meeting:ibabs:gemeente:utrecht:m1"));
  assertEquals(event.data.entity_id, "meeting:ibabs:gemeente:utrecht:m1", "entity id");
  assertEquals(event.data.entity_type, "Meeting", "entity type");
  assertEquals(event.data.source.supplier, "ibabs", "supplier survives");
  assertEquals(event.data.source.source, "utrecht", "source key survives");
  assertEquals(event.source, "/woozi/ibabs/utrecht", "cloudevents source uri");
  assertEquals(event.data.op, "upsert", "reindex only ever upserts");
  assertEquals(event.id, "commit:meeting:ibabs:gemeente:utrecht:m1:abc", "keeps the commit id");
});

Deno.test("reindex projects stored entities without touching any supplier API", async () => {
  const log = new FakeExportLog([
    meetingRecord("meeting:ibabs:gemeente:utrecht:m1"),
    meetingRecord("meeting:ibabs:gemeente:utrecht:m2"),
  ]);
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    storage: undefined,
    batchSize: 64,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
  });

  assertEquals(stats.entity_count, 2, "both meetings projected");
  assertEquals(ingested.length, 2, "one quickwit document per meeting");
  assertEquals(ingested[0].entity_type, "Meeting", "projected type");
  assert(ingested[0].content?.includes("Gemeenteraad"), "meeting stays searchable");
  assert(
    ingested[0].content?.includes("Programmabegroting"),
    "agenda text survives the round trip",
  );
});

function recordingRecord(id: string, transcriptKey?: string): ExportChangeRecord {
  return {
    seq: 3,
    op: "upsert",
    time: "2026-01-29T10:00:00.000Z",
    entity_id: id,
    entity_type: "Recording",
    source_key: "utrecht",
    supplier: "ibabs",
    commit_id: `commit:${id}:abc`,
    content_hash: "sha256:rec",
    // Exactly what compactEntityPayload writes: chapters and speakers survive,
    // `segments` does not.
    payload: {
      type: "Recording",
      name: "Gemeenteraad",
      media_type: "video",
      meeting: "meeting:ibabs:gemeente:utrecht:m1",
      start_date: "2026-01-29T19:30:00Z",
      chapters: [{ start_seconds: 0, title: "1 Opening" }],
      derived_content: transcriptKey ? { transcript_key: transcriptKey } : undefined,
    },
  };
}

Deno.test("a transcript is rehydrated on reindex, not silently dropped", async () => {
  // The export record deliberately omits the transcript, so without rehydration
  // a reindex would re-project the recording with only its title and chapters —
  // the spoken word would vanish from search while the row still looked fine.
  const transcript = JSON.stringify({
    segments: [
      { start_seconds: 10, end_seconds: 40, text: "Van harte welkom in deze raadzaal" },
      { start_seconds: 40, end_seconds: 90, text: "Aan de orde is de woningbouwopgave" },
    ],
    chapters: [{ start_seconds: 0, title: "1 Opening" }],
    speakers: [{ start_seconds: 10, name: "Halsema" }],
  });
  const storage = new FakeStorage({ "recordings/rec-1/transcript.json": transcript });
  const log = new FakeExportLog([
    recordingRecord("recording:ibabs:gemeente:utrecht:r1", "recordings/rec-1/transcript.json"),
  ]);
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    // deno-lint-ignore no-explicit-any
    storage: storage as any,
    batchSize: 64,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
  });

  assertEquals(stats.rehydrated_count, 1, "one transcript rehydrated");
  assertEquals(storage.reads, ["recordings/rec-1/transcript.json"], "read the stored transcript");
  assertEquals(ingested.length, 1, "one row per recording, as in phase A");
  assert(
    ingested[0].content?.includes("woningbouwopgave"),
    `spoken text must survive the round trip, got: ${ingested[0].content}`,
  );
  assert(ingested[0].content?.includes("Halsema"), "speakers come back too");
  assertEquals(
    ingested[0].parent_entity_id,
    "meeting:ibabs:gemeente:utrecht:m1",
    "and it still hangs off its meeting",
  );
});

Deno.test("a recording without a stored transcript reindexes without failing", async () => {
  const log = new FakeExportLog([recordingRecord("recording:ibabs:gemeente:utrecht:r2")]);
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    storage: undefined,
    batchSize: 64,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
  });

  assertEquals(stats.issue_count, 0, "a recording with no transcript is normal, not an issue");
  assertEquals(stats.rehydrated_count, 0, "nothing to rehydrate");
  assert(ingested[0].content?.includes("Opening"), "the chapters still make it searchable");
});

Deno.test("rehydration reads run in parallel, and the order still holds", async () => {
  // The reindex is bounded by object-storage latency: one read per document,
  // 57% of live entities carrying stored text. Doing them one at a time held a
  // source to ~4 entities/second, which made Amsterdam alone a ~14 hour floor
  // for the whole reindex — a source cannot be split across workers.
  const objects: Record<string, string> = {};
  const records: ExportChangeRecord[] = [];
  for (let i = 0; i < 12; i += 1) {
    const key = `text/doc-${i}/md.md`;
    objects[key] = `inhoud van document ${i}`;
    records.push(
      documentRecord(`document:ibabs:gemeente:utrecht:d${String(i).padStart(2, "0")}`, {
        markdown: key,
      }),
    );
  }

  const storage = new FakeStorage(objects, 15);
  const log = new FakeExportLog(records);
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    // deno-lint-ignore no-explicit-any
    storage: storage as any,
    batchSize: 1000,
    rehydrateConcurrency: 4,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
  });

  assertEquals(stats.entity_count, 12, "every record is projected");
  assertEquals(stats.rehydrated_count, 12, "every document is rehydrated");
  assert(storage.peakConcurrency > 1, `reads must overlap, peak was ${storage.peakConcurrency}`);
  assert(
    storage.peakConcurrency <= 4,
    `and must respect the limit, peak was ${storage.peakConcurrency}`,
  );

  // Parallel reads must not reshuffle what gets indexed.
  const ids = ingested.map((doc) => doc.entity_id);
  assertEquals([...ids].sort(), ids, `projection order must follow the export log: ${ids}`);
  assert(ingested[0].content?.includes("inhoud van document 0"), "text arrives with its entity");
});

Deno.test("a failing rehydration is reported per record, not per slice", async () => {
  // One unreadable object must cost one entity, not the whole parallel batch.
  const log = new FakeExportLog([
    documentRecord("document:ibabs:gemeente:utrecht:d1", { chunks: "text/ok.json" }),
    documentRecord("document:ibabs:gemeente:utrecht:d2", { chunks: "text/kapot.json" }),
    documentRecord("document:ibabs:gemeente:utrecht:d3", { chunks: "text/ok.json" }),
  ]);
  const storage = new FakeStorage({
    "text/ok.json": JSON.stringify([{ page_number: 1, markdown: "prima" }]),
    "text/kapot.json": "{ dit is geen json",
  });
  const issues: string[] = [];
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    // deno-lint-ignore no-explicit-any
    storage: storage as any,
    batchSize: 1000,
    rehydrateConcurrency: 3,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
    onIssue: (issue) => {
      issues.push(issue.entity_id ?? "");
    },
  });

  assertEquals(stats.issue_count, 1, "exactly one record fails");
  assertEquals(issues, ["document:ibabs:gemeente:utrecht:d2"], "and it is named");
  assertEquals(stats.entity_count, 2, "the other two still land");
});

Deno.test("document text is rehydrated from object storage, not lost", async () => {
  // The shape materializeDocument actually writes: an object with `pages`, at
  // both of its write sites. This fixture used to be a bare array, which no
  // production object has ever been -- so the test passed while the reindex
  // silently restored nothing and every document lost its page rows.
  const chunks = JSON.stringify({
    pages: [
      { page_number: 1, markdown: "Eerste pagina over de begroting" },
      { page_number: 2, markdown: "Tweede pagina met de dekking" },
    ],
  });
  const storage = new FakeStorage({ "text/doc-1/chunks.json": chunks });
  const log = new FakeExportLog([
    documentRecord("document:ibabs:gemeente:utrecht:d1", { chunks: "text/doc-1/chunks.json" }),
  ]);
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    // deno-lint-ignore no-explicit-any
    storage: storage as any,
    batchSize: 64,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
  });

  assertEquals(stats.rehydrated_count, 1, "one document rehydrated");
  assertEquals(storage.reads, ["text/doc-1/chunks.json"], "read the stored chunks");

  // The whole point: page documents come back, so full-text search still works.
  const pages = ingested.filter((doc) => doc.entity_type === "DocumentPage");
  assertEquals(pages.length, 2, "one indexed document per page");
  assert(pages[0].content?.includes("begroting"), "page text is indexed again");
  assertEquals(pages[0].parent_entity_id, "document:ibabs:gemeente:utrecht:d1", "page links home");
});

Deno.test("a document falls back to markdown when there are no page chunks", async () => {
  const storage = new FakeStorage({ "text/doc-2/full.md": "# Raadsvoorstel\n\nInhoud" });
  const log = new FakeExportLog([
    documentRecord("document:ibabs:gemeente:utrecht:d2", { markdown: "text/doc-2/full.md" }),
  ]);
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    // deno-lint-ignore no-explicit-any
    storage: storage as any,
    batchSize: 64,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
  });

  assertEquals(stats.rehydrated_count, 1, "rehydrated from markdown");
  assert(ingested[0].content?.includes("Inhoud"), "markdown reaches the index");
});

Deno.test("reindex pages through the whole source and batches its writes", async () => {
  const records = Array.from({ length: 25 }, (_, index) =>
    meetingRecord(`meeting:ibabs:gemeente:utrecht:m${String(index).padStart(3, "0")}`),
  );
  const log = new FakeExportLog(records);
  const batches: number[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    storage: undefined,
    batchSize: 10,
    pageSize: 7,
    ingest: (documents) => {
      batches.push(documents.length);
      return Promise.resolve();
    },
  });

  assertEquals(stats.entity_count, 25, "every entity reindexed exactly once");
  assertEquals(
    batches.reduce((a, b) => a + b, 0),
    25,
    "and written exactly once",
  );
  assert(batches.length > 1, "writes are batched rather than one giant request");
  assert(log.pageRequests.length >= 4, "paged through the source with a cursor");
  // Cursor advances rather than repeating: a stuck cursor would loop forever.
  assertEquals(new Set(log.pageRequests).size, log.pageRequests.length, "cursor always advances");
});

Deno.test("one unreadable entity is reported, not fatal", async () => {
  const broken: ExportChangeRecord = {
    ...documentRecord("document:ibabs:gemeente:utrecht:d3", { chunks: "text/broken.json" }),
  };
  const storage = new FakeStorage({ "text/broken.json": "{ this is not json" });
  const log = new FakeExportLog([broken, meetingRecord("meeting:ibabs:gemeente:utrecht:zz")]);
  const issues: string[] = [];
  const ingested: QuickwitSearchDocument[] = [];

  const stats = await reindexSource("utrecht", {
    // deno-lint-ignore no-explicit-any
    exportLog: log as any,
    // deno-lint-ignore no-explicit-any
    storage: storage as any,
    batchSize: 64,
    ingest: (documents) => {
      ingested.push(...documents);
      return Promise.resolve();
    },
    onIssue: (issue) => {
      issues.push(issue.entity_id ?? "");
    },
  });

  assertEquals(stats.issue_count, 1, "the broken record is counted");
  assertEquals(issues, ["document:ibabs:gemeente:utrecht:d3"], "and identified");
  assertEquals(stats.entity_count, 1, "the healthy entity still went through");
  assertEquals(ingested.length, 1, "and was indexed");
});

/** The reader accepts a bare array too, so this fix cannot make an older object
 * unreadable. Nothing is known to have written this shape; it costs one branch
 * to keep, and losing page rows is not a failure that announces itself. */
Deno.test("a bare array of page chunks is still readable", () => {
  const pages = parseStoredPageChunks(
    JSON.stringify([{ page_number: 1, markdown: "Eerste pagina" }]),
  );
  assertEquals(pages?.length, 1, "a bare array still parses");
  assertEquals(pages?.[0].page_number, 1, "and keeps its page number");
});

Deno.test("stored page chunks are read out of the object they are stored in", () => {
  const stored = JSON.stringify({
    pages: [
      { page_number: 1, markdown: "Eerste" },
      { page_number: 2, markdown: "Tweede" },
    ],
  });
  assertEquals(parseStoredPageChunks(stored)?.length, 2, "both pages come back");
  assertEquals(parseStoredPageChunks("{}"), null, "an object without pages yields nothing");

  // Corruption stays loud: the caller turns this into a per-record issue, so a
  // damaged object is reported rather than quietly downgraded to markdown.
  let threw = false;
  try {
    parseStoredPageChunks("{ geen json");
  } catch {
    threw = true;
  }
  assert(threw, "unparseable input throws rather than returning nothing");
});
