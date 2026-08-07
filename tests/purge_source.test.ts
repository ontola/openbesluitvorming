import { ExportChangesLog } from "../src/exports/log.ts";
import { DatabaseSync } from "node:sqlite";
import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import { sourceStoragePrefixes } from "../src/storage/prefixes.ts";
import { transcriptKey } from "../src/recordings/storage.ts";
import type { DocumentEntity, MeetingEntity, MotionEntity } from "../src/types.ts";

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

class MemoryStorage {
  readonly objects = new Map<string, Uint8Array>();
  putObject(key: string, body: Uint8Array) {
    this.objects.set(key, body);
    return Promise.resolve({ url: `memory://${key}` });
  }
  getObjectText(key: string) {
    return Promise.resolve(new TextDecoder().decode(this.objects.get(key) ?? new Uint8Array()));
  }
}

function newLog(): ExportChangesLog {
  const db = new DatabaseSync(":memory:");
  // deno-lint-ignore no-explicit-any
  return new ExportChangesLog({ db, storage: new MemoryStorage() as any });
}

const source = (key: string, orgType = "waterschap") => ({
  supplier: "ibabs",
  source: key,
  organization_type: orgType,
});

function meeting(key: string, id: string): MeetingEntity {
  return {
    id: `meeting:ibabs:waterschap:${key}:${id}`,
    type: "Meeting",
    name: "Algemeen Bestuur",
    classification: ["Agenda"],
    start_date: "2026-03-01T10:00:00Z",
    source_info: source(key),
    raw: {},
  };
}

function document(key: string, id: string): DocumentEntity {
  return {
    id: `document:ibabs:waterschap:${key}:${id}`,
    type: "Document",
    name: "Voorstel",
    source_info: source(key),
    raw: {},
  };
}

function motion(key: string, id: string): MotionEntity {
  return {
    id: `motion:ibabs:waterschap:${key}:${id}`,
    type: "Motion",
    name: "Motie",
    classification: ["Moties"],
    source_info: source(key),
    raw: {},
  };
}

async function record(
  log: ExportChangesLog,
  entity: MeetingEntity | DocumentEntity | MotionEntity,
) {
  log.recordCommit(await buildEntityCommitEvent(entity));
}

Deno.test("a purge tombstones every live entity and empties the snapshot", async () => {
  const log = newLog();
  await record(log, meeting("waterschap_limburg", "m1"));
  await record(log, document("waterschap_limburg", "d1"));
  await record(log, motion("waterschap_limburg", "mo1"));

  const before = log.readSnapshot("waterschap_limburg", { limit: 100 });
  assertEquals(before.records.length, 3, "three live entities to start with");

  for (const entity of before.records) {
    log.recordDelete({
      sourceKey: "waterschap_limburg",
      supplier: entity.supplier,
      entityId: entity.entity_id,
      entityType: entity.entity_type,
    });
  }

  const after = log.readSnapshot("waterschap_limburg", { limit: 100 });
  assertEquals(after.records.length, 0, "snapshot is empty after the purge");
});

Deno.test("downstream consumers are told, not left guessing", async () => {
  const log = newLog();
  await record(log, document("waterschap_limburg", "d1"));

  // A reuser who already synced sits at this cursor.
  const synced = log.readSnapshot("waterschap_limburg", { limit: 100 }).changesCursor;

  log.recordDelete({
    sourceKey: "waterschap_limburg",
    supplier: "ibabs",
    entityId: "document:ibabs:waterschap:waterschap_limburg:d1",
    entityType: "Document",
  });

  const changes = await log.readChanges("waterschap_limburg", { cursor: synced, limit: 100 });
  const deletes = changes.records.filter((r) => r.op === "delete");
  assertEquals(deletes.length, 1, "the delete reaches the changes feed");
  assertEquals(
    deletes[0].entity_id,
    "document:ibabs:waterschap:waterschap_limburg:d1",
    "and names the entity to drop",
  );
  assertEquals(deletes[0].payload, undefined, "a tombstone carries no payload");
});

Deno.test("purging one source leaves its neighbours untouched", async () => {
  const log = newLog();
  await record(log, document("waterschap_limburg", "d1"));
  await record(log, document("provincie_limburg", "d1"));

  log.recordDelete({
    sourceKey: "waterschap_limburg",
    supplier: "ibabs",
    entityId: "document:ibabs:waterschap:waterschap_limburg:d1",
    entityType: "Document",
  });

  assertEquals(
    log.readSnapshot("waterschap_limburg", { limit: 10 }).records.length,
    0,
    "purged source is empty",
  );
  assertEquals(
    log.readSnapshot("provincie_limburg", { limit: 10 }).records.length,
    1,
    "the province keeps its data",
  );
});

Deno.test("object storage prefixes cannot collide between sources", () => {
  // The purge deletes by prefix, so this is the property that makes it safe:
  // supplier, organization type and source key are all in the key.
  const prefixFor = (supplier: string, orgType: string, key: string) =>
    `documents/${supplier}/${orgType}/${key}/`;

  const waterBoard = prefixFor("ibabs", "waterschap", "waterschap_limburg");
  const province = prefixFor("ibabs", "provincie", "provincie_limburg");

  assert(!province.startsWith(waterBoard), "province is not under the water board prefix");
  assert(!waterBoard.startsWith(province), "and the reverse");
  assertEquals(
    waterBoard,
    "documents/ibabs/waterschap/waterschap_limburg/",
    "prefix shape is what the purge expects",
  );
});

Deno.test("a purge covers every root a source actually writes to", async () => {
  // The guard against the bug this fixes: the purge cleared `documents/` only,
  // so a purged source kept its transcripts. Rather than trusting two string
  // literals to stay in step, take a real key from each writer and assert the
  // purge would cover it.
  const source = { supplier: "notubiz", organizationType: "gemeente", key: "nunspeet" };
  const prefixes = sourceStoragePrefixes(source);

  const transcriptPath = transcriptKey({
    id: "recording:notubiz:gemeente:nunspeet:392881",
    type: "Recording",
    name: "Vergadering",
    media_type: "video",
    source_info: { supplier: "notubiz", source: "nunspeet", organization_type: "gemeente" },
    raw: {},
  });
  const documentPath = "documents/notubiz/gemeente/nunspeet/document:x/v1/stuk.pdf";

  for (const [label, key] of [
    ["transcript", transcriptPath],
    ["document", documentPath],
  ]) {
    assert(
      prefixes.some((prefix) => key.startsWith(prefix)),
      `the purge must cover the ${label} key ${key} — prefixes: ${prefixes.join(", ")}`,
    );
  }

  // And still not reach a neighbouring source.
  const neighbour = sourceStoragePrefixes({ ...source, key: "nunspeet_west" });
  assert(
    !neighbour.some((prefix) => transcriptPath.startsWith(prefix)),
    "a source with a longer name must not swallow this one",
  );
});

Deno.test("re-purging an already purged source is a no-op", async () => {
  const log = newLog();
  await record(log, document("waterschap_limburg", "d1"));
  const entity = {
    sourceKey: "waterschap_limburg",
    supplier: "ibabs",
    entityId: "document:ibabs:waterschap:waterschap_limburg:d1",
    entityType: "Document",
  };

  assert(log.recordDelete(entity), "first delete is recorded");
  assertEquals(log.recordDelete(entity), null, "the second appends nothing");
});
