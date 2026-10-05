import { DatabaseSync } from "node:sqlite";
import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import { ExportChangesLog, type ExportSegmentStorage } from "../src/exports/log.ts";
import type { SourcePresence, SourceProbe } from "../src/documents/source_presence.ts";
import { retractDocumentsGoneAtSource } from "../src/ops/delete_document.ts";
import { confirmRemovalsAtSource, SourceRemovalTracker } from "../src/pipeline/source_removals.ts";
import type { DocumentEntity, MeetingEntity, MotionEntity, WooziEntity } from "../src/types.ts";

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

const storage: ExportSegmentStorage = {
  putObject: () => Promise.resolve({}),
  getObjectText: () => Promise.resolve(""),
};

const SOURCE = "soest";
const sourceInfo = (canonicalId: string) => ({
  supplier: "notubiz",
  source: SOURCE,
  organization_type: "gemeente" as const,
  canonical_id: canonicalId,
});

const docId = (n: number) => `document:notubiz:gemeente:${SOURCE}:${n}`;

function meeting(n: number, documents: number[]): MeetingEntity {
  return {
    id: `meeting:notubiz:gemeente:${SOURCE}:${n}`,
    type: "Meeting",
    name: `Raad ${n}`,
    classification: ["Agenda"],
    start_date: "2026-09-30T19:30:00Z",
    attachment: documents.map(docId),
    source_info: sourceInfo(String(n)),
    raw: {},
  };
}

function document(n: number): DocumentEntity {
  return {
    id: docId(n),
    type: "Document",
    name: `Document ${n}`,
    original_url: `https://api.notubiz.nl/document/${n}/1`,
    source_info: sourceInfo(String(n)),
    raw: {},
  };
}

async function commit(log: ExportChangesLog, entity: WooziEntity): Promise<void> {
  log.recordCommit(await buildEntityCommitEvent(entity));
}

/** A log as an earlier import left it: meeting 1 with documents 1-3. */
async function seeded(): Promise<ExportChangesLog> {
  const log = new ExportChangesLog({ db: new DatabaseSync(":memory:"), storage });
  for (const n of [1, 2, 3]) {
    await commit(log, document(n));
  }
  await commit(log, meeting(1, [1, 2, 3]));
  return log;
}

/** What a run does per entity, in order: observe, then commit. */
async function run(
  log: ExportChangesLog,
  entities: WooziEntity[],
  maxPerRun = 25,
): Promise<ReturnType<SourceRemovalTracker["plan"]>> {
  const tracker = new SourceRemovalTracker(SOURCE, log);
  for (const entity of entities) {
    tracker.observeEmitted(entity.id);
    if (entity.type === "Meeting") {
      tracker.observeMeeting(entity);
    }
    await commit(log, entity);
  }
  return tracker.plan(maxPerRun);
}

Deno.test("a document the meeting no longer lists is planned for removal", async () => {
  const log = await seeded();
  const plan = await run(log, [meeting(1, [1, 3]), document(1), document(3)]);
  assertEquals(
    plan.remove,
    [{ entityId: docId(2), meetingId: meeting(1, []).id }],
    "document 2 left the agenda",
  );
});

Deno.test("an unchanged meeting removes nothing", async () => {
  const log = await seeded();
  const plan = await run(log, [meeting(1, [1, 2, 3])]);
  assertEquals(plan.remove, [], "nothing changed");
});

Deno.test("a meeting that lost every document is left alone", async () => {
  const log = await seeded();
  const plan = await run(log, [meeting(1, [])]);
  assertEquals(plan.remove, [], "an emptied agenda looks like a fault, not a deletion");
  assertEquals(plan.skippedMeetings, [meeting(1, []).id], "and is reported");
});

Deno.test("a meeting that did not come back removes nothing", async () => {
  const log = await seeded();
  const plan = await run(log, []);
  assertEquals(plan.remove, [], "no meeting, no comparison");
});

Deno.test("a document that moved to a meeting in the same run is kept", async () => {
  const log = await seeded();
  const plan = await run(log, [meeting(1, [1, 3]), meeting(2, [2]), document(2)]);
  assertEquals(plan.remove, [], "document 2 was emitted again");
});

Deno.test("a document another meeting or motion still lists is kept", async () => {
  const log = await seeded();
  await commit(log, meeting(7, [2]));
  const motion: MotionEntity = {
    id: `motion:notubiz:gemeente:${SOURCE}:1`,
    type: "Motion",
    name: "Motie",
    classification: ["Motie"],
    attachment: [docId(3)],
    source_info: sourceInfo("m1"),
    raw: {},
  };
  await commit(log, motion);
  const plan = await run(log, [meeting(1, [1])]);
  assertEquals(plan.remove, [], "documents 2 and 3 are still referenced elsewhere");
});

Deno.test("a document that is already deleted is not removed again", async () => {
  const log = await seeded();
  log.recordDelete({
    sourceKey: SOURCE,
    supplier: "notubiz",
    entityId: docId(2),
    entityType: "Document",
  });
  const plan = await run(log, [meeting(1, [1, 3])]);
  assertEquals(plan.remove, [], "the tombstone is already there");
});

Deno.test("more removals than the cap removes none and says so", async () => {
  const log = await seeded();
  const plan = await run(log, [meeting(1, [1])], 1);
  assertEquals(plan.remove, [], "over the cap nothing is removed");
  assertEquals(plan.capExceeded, { candidates: 2, max: 1 }, "the cap is reported");
});

function probeAnswering(answers: Record<number, SourcePresence>) {
  const asked: number[] = [];
  const probe = (_supplier: string, url: string | undefined): Promise<SourceProbe> => {
    const n = Number(/document\/(\d+)\//.exec(url ?? "")?.[1]);
    asked.push(n);
    const presence = answers[n] ?? "unknown";
    return Promise.resolve({ presence, url, status: presence === "live" ? 200 : 400 });
  };
  return { probe, asked };
}

async function confirm(answers: Record<number, SourcePresence>) {
  const log = await seeded();
  const plan = await run(log, [meeting(1, [1])]);
  const { probe, asked } = probeAnswering(answers);
  const result = await confirmRemovalsAtSource(plan, {
    sourceKey: SOURCE,
    supplier: "notubiz",
    log,
    probe,
  });
  return { result, asked };
}

Deno.test("only documents the supplier confirms gone are removed", async () => {
  const { result, asked } = await confirm({ 1: "live", 2: "gone", 3: "live" });
  assertEquals(asked, [1, 2, 3], "the control document is asked first");
  assertEquals(
    result.remove.map((entry) => entry.entityId),
    [docId(2)],
    "document 3 was only unlinked and still downloads",
  );
  assertEquals(
    result.kept.map((entry) => [entry.entityId, entry.probe?.presence]),
    [[docId(3), "live"]],
    "and is kept",
  );
  assertEquals(
    result.remove[0].probe,
    { presence: "gone", url: "https://api.notubiz.nl/document/2/1", status: 400 },
    "the supplier's answer travels along as evidence",
  );
  assertEquals(result.control?.entityId, docId(1), "so does the control document");
});

Deno.test("an unanswered probe keeps the document", async () => {
  const { result } = await confirm({ 1: "live", 2: "unknown", 3: "gone" });
  assertEquals(
    result.remove.map((entry) => entry.entityId),
    [docId(3)],
    "unknown is not gone",
  );
});

Deno.test("when the control document is not live, nothing is removed", async () => {
  const { result, asked } = await confirm({ 1: "gone", 2: "gone", 3: "gone" });
  assertEquals(result.remove, [], "an outage looks like every document gone");
  assertEquals(result.controlFailed, true, "and is reported as such");
  assertEquals(result.kept.length, 2, "every candidate is kept");
  assertEquals(asked, [1], "the candidates are not even asked");
});

class FakeQuickwit {
  readonly ingested: string[][] = [];
  readonly deleteTasks: string[] = [];
  searchRequest() {
    return Promise.resolve({ hits: [], num_hits: 0 } as never);
  }
  ingestDocuments(documents: Array<{ entity_id?: string }>) {
    this.ingested.push(documents.map((document) => document.entity_id ?? ""));
    return Promise.resolve() as never;
  }
  createDeleteTask(query: string) {
    this.deleteTasks.push(query);
    return Promise.resolve();
  }
}

Deno.test("a retraction hides, tombstones with its reason, then empties storage", async () => {
  const log = await seeded();
  const quickwit = new FakeQuickwit();
  const deleted: string[] = [];
  const outcomes = await retractDocumentsGoneAtSource(
    [{ entityId: docId(2), meetingId: meeting(1, []).id }],
    {
      quickwit,
      storage: {
        deleteByPrefix: (prefix) => {
          deleted.push(prefix);
          return Promise.resolve([]);
        },
      },
      exportLog: log,
    },
  );
  assertEquals(outcomes, [{ entityId: docId(2), reached: "deleted" }], "fully retracted");
  assertEquals(quickwit.ingested, [[docId(2)]], "a delete marker hides it from search");
  assertEquals(quickwit.deleteTasks.length, 1, "one delete task");
  assertEquals(deleted.length, 4, "every storage prefix is emptied");
  const tombstone = log.getEntityRecord(SOURCE, docId(2));
  assertEquals(
    [tombstone?.op, tombstone?.reason, tombstone?.meeting_id],
    ["delete", "removed_at_source", meeting(1, []).id],
    "the tombstone says why and from which meeting",
  );
});

Deno.test("a storage failure halfway leaves the feed and search in step", async () => {
  const log = await seeded();
  const quickwit = new FakeQuickwit();
  const outcomes = await retractDocumentsGoneAtSource(
    [
      { entityId: docId(2), meetingId: meeting(1, []).id },
      { entityId: docId(3), meetingId: meeting(1, []).id },
    ],
    {
      quickwit,
      storage: {
        deleteByPrefix: (prefix) =>
          prefix.includes(`${SOURCE}/2/`)
            ? Promise.reject(new Error("simulated S3 outage"))
            : Promise.resolve([]),
      },
      exportLog: log,
    },
  );
  assertEquals(
    outcomes,
    [
      { entityId: docId(2), reached: "tombstoned", error: "simulated S3 outage" },
      { entityId: docId(3), reached: "deleted" },
    ],
    "the failing document reports the step it reached, the next one still runs",
  );
  assertEquals(
    log.getEntityRecord(SOURCE, docId(2))?.op,
    "delete",
    "a document hidden from search is also gone from the feed",
  );
  assert(
    quickwit.deleteTasks[0].includes(docId(2)) && quickwit.deleteTasks[0].includes(docId(3)),
    "both are in the delete task",
  );
});

Deno.test("a failure before the marker leaves the document untouched", async () => {
  const log = await seeded();
  const quickwit = new FakeQuickwit();
  quickwit.ingestDocuments = () => Promise.reject(new Error("quickwit down")) as never;
  const outcomes = await retractDocumentsGoneAtSource(
    [{ entityId: docId(2), meetingId: meeting(1, []).id }],
    { quickwit, storage: { deleteByPrefix: () => Promise.resolve([]) }, exportLog: log },
  );
  assertEquals(outcomes, [{ entityId: docId(2), reached: "nothing", error: "quickwit down" }], "");
  assertEquals(log.getEntityRecord(SOURCE, docId(2))?.op, "upsert", "still in the feed");
  assertEquals(quickwit.deleteTasks, [], "no delete task for it");
});
