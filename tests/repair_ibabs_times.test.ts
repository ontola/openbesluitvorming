import { assertEquals } from "jsr:@std/assert";
import { DatabaseSync } from "node:sqlite";
import { ExportChangesLog, type ExportSegmentStorage } from "../src/exports/log.ts";
import {
  IBABS_ZULU_STAMPING_ENDED_AT,
  planIbabsTimeRepair,
  repairIbabsTimes,
} from "../src/pipeline/repair_ibabs_times.ts";
import { reinterpretZuluAsWallClock } from "../src/util/local_time.ts";
import type { ExportChangeRecord } from "../src/types.ts";

class FakeStorage implements ExportSegmentStorage {
  readonly objects = new Map<string, string>();
  putObject(key: string, body: Uint8Array): Promise<unknown> {
    this.objects.set(key, new TextDecoder().decode(body));
    return Promise.resolve({});
  }
  getObjectText(key: string): Promise<string> {
    return Promise.resolve(this.objects.get(key) ?? "");
  }
}

const BEFORE_FIX = "2026-07-14T01:55:17.119Z";
const AFTER_FIX = "2026-09-06T10:00:00.000Z";

function record(
  overrides: Partial<ExportChangeRecord> & { payload: Record<string, unknown> },
): Omit<ExportChangeRecord, "seq"> {
  return {
    op: "upsert",
    time: BEFORE_FIX,
    entity_id: `meeting:ibabs:gemeente:gouda:${crypto.randomUUID()}`,
    entity_type: "Meeting",
    source_key: "gouda",
    supplier: "ibabs",
    content_hash: `sha256:${crypto.randomUUID()}`,
    ...overrides,
  };
}

Deno.test("reinterpretZuluAsWallClock reads the old stamping as Dutch time", () => {
  // Gouda's raadsvergadering of 3 July 2024 (#203): 19:30 local, summer time.
  assertEquals(reinterpretZuluAsWallClock("2024-07-03T19:30:00Z"), "2024-07-03T17:30:00Z");
  // Winter time, and the edge of a day: 23:58 must stay on 1 March.
  assertEquals(reinterpretZuluAsWallClock("2024-03-01T23:58:00Z"), "2024-03-01T22:58:00Z");
  // A date, not a moment.
  assertEquals(reinterpretZuluAsWallClock("2024-03-01T00:00:00Z"), "2024-03-01T00:00:00Z");
  // Shapes the old normaliser never wrote are left alone.
  assertEquals(reinterpretZuluAsWallClock("2024-03-01T12:00:00.000Z"), "2024-03-01T12:00:00.000Z");
  assertEquals(
    reinterpretZuluAsWallClock("2024-03-01T19:30:00+01:00"),
    "2024-03-01T19:30:00+01:00",
  );
});

Deno.test("planIbabsTimeRepair only touches iBabs records written before the fix", () => {
  const payload = {
    type: "Meeting",
    start_date: "2024-07-03T19:30:00Z",
    end_date: "2024-07-03T23:00:00Z",
    last_discussed_at: "2024-07-03T19:30:00Z",
  };
  const old = { ...record({ payload }), seq: 1 };
  const repair = planIbabsTimeRepair(old);
  assertEquals(repair?.payload.start_date, "2024-07-03T17:30:00Z");
  assertEquals(repair?.payload.end_date, "2024-07-03T21:00:00Z");
  assertEquals(repair?.payload.last_discussed_at, "2024-07-03T17:30:00Z");
  // The stored record itself is not mutated.
  assertEquals((old.payload as typeof payload).start_date, "2024-07-03T19:30:00Z");

  assertEquals(planIbabsTimeRepair({ ...old, time: AFTER_FIX }), null);
  assertEquals(planIbabsTimeRepair({ ...old, supplier: "notubiz" }), null);
  assertEquals(planIbabsTimeRepair({ ...old, entity_type: "Recording" }), null);
  // A record written in the minutes of the deploy is left alone.
  assertEquals(planIbabsTimeRepair({ ...old, time: IBABS_ZULU_STAMPING_ENDED_AT }), null);
  assertEquals(
    planIbabsTimeRepair({
      ...old,
      payload: { type: "Meeting", start_date: "2024-07-03T00:00:00Z" },
    }),
    null,
  );
});

Deno.test("repairIbabsTimes appends corrected records once, and only with apply", async () => {
  const log = new ExportChangesLog({
    db: new DatabaseSync(":memory:"),
    storage: new FakeStorage(),
  });
  const meeting = log.recordRepair(
    record({
      entity_id: "meeting:ibabs:gemeente:gouda:f6ae618d-1101-4514-94a4-6125fb8d6924",
      payload: {
        type: "Meeting",
        start_date: "2024-07-03T19:30:00Z",
        end_date: "2024-07-03T23:00:00Z",
        last_discussed_at: "2024-07-03T19:30:00Z",
      },
    }),
  )!;
  log.recordRepair(
    record({
      entity_type: "Document",
      entity_id: "document:ibabs:gemeente:gouda:a",
      payload: { type: "Document", last_discussed_at: "2024-07-03T19:30:00Z" },
    }),
  );
  // Written by the fixed normaliser: already correct, must not move again.
  log.recordRepair(
    record({
      time: AFTER_FIX,
      entity_id: "meeting:ibabs:gemeente:gouda:new",
      payload: { type: "Meeting", start_date: "2025-09-10T17:00:00Z" },
    }),
  );

  const dry = await repairIbabsTimes("gouda", { exportLog: log, apply: false });
  assertEquals(dry.scanned, 3);
  assertEquals(dry.repaired, 2);
  assertEquals(dry.byType, { Meeting: 1, Document: 1 });
  assertEquals(log.getEntityRecord("gouda", meeting.entity_id)?.seq, meeting.seq);

  const projected: ExportChangeRecord[] = [];
  const now = "2026-11-06T09:00:00.000Z";
  const applied = await repairIbabsTimes("gouda", {
    exportLog: log,
    apply: true,
    now: () => now,
    onRepaired: (records) => {
      projected.push(...records);
      return Promise.resolve();
    },
  });
  assertEquals(applied.repaired, 2);
  assertEquals(projected.length, 2);

  const stored = log.getEntityRecord("gouda", meeting.entity_id)!;
  assertEquals((stored.payload as Record<string, string>).start_date, "2024-07-03T17:30:00Z");
  assertEquals(stored.time, now);
  assertEquals(stored.seq > meeting.seq, true);
  // The change feed carries the correction to consumers.
  const changes = await log.readChanges("gouda", { cursor: String(meeting.seq + 1), limit: 100 });
  assertEquals(
    changes.records.some((change) => change.entity_id === meeting.entity_id && change.time === now),
    true,
  );

  // Running it again finds nothing: the repaired records carry a new time.
  const again = await repairIbabsTimes("gouda", { exportLog: log, apply: true });
  assertEquals(again.repaired, 0);
});
