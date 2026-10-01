import { DatabaseSync } from "node:sqlite";
import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import { ExportChangesLog, type ExportSegmentStorage } from "../src/exports/log.ts";
import type { SourcePresence } from "../src/documents/source_presence.ts";
import { confirmRemovalsAtSource, SourceRemovalTracker } from "../src/pipeline/source_removals.ts";
import type { DocumentEntity, MeetingEntity, MotionEntity, WooziEntity } from "../src/types.ts";

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
  const probe = (_supplier: string, url: string | undefined): Promise<SourcePresence> => {
    const n = Number(/document\/(\d+)\//.exec(url ?? "")?.[1]);
    asked.push(n);
    return Promise.resolve(answers[n] ?? "unknown");
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
  assertEquals(result.kept, [{ entityId: docId(3), presence: "live" }], "and is kept");
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
  assertEquals(result.controlFailed, "gone", "and is reported as such");
  assertEquals(asked, [1], "the candidates are not even asked");
});
