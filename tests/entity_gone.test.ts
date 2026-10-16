import { assertEquals } from "jsr:@std/assert";
import { entityGoneResponse, sourceKeyOfEntityId } from "../web/entity_gone.ts";
import type { ExportChangeRecord } from "../src/types.ts";

const tombstone: ExportChangeRecord = {
  seq: 33634,
  op: "delete",
  time: "2026-10-10T01:50:40.454Z",
  entity_id: "document:ibabs:gemeente:harderwijk:25d495ba-ebcb-4888-a490-235fb71cf7df",
  entity_type: "Document",
  source_key: "harderwijk",
  supplier: "ibabs",
  reason: "removed_at_source",
  meeting_id: "meeting:ibabs:gemeente:harderwijk:7566f1e5-d552-4bcb-b2f5-7fc2303b44d6",
};

Deno.test("the source key is the fourth segment of a canonical id", () => {
  assertEquals(sourceKeyOfEntityId(tombstone.entity_id), "harderwijk");
  assertEquals(
    sourceKeyOfEntityId("document:ibabs:waterschap:waterschap_limburg:01c3ab34"),
    "waterschap_limburg",
  );
  assertEquals(sourceKeyOfEntityId("not-an-id"), undefined);
});

Deno.test("a document removed at the source answers 410 with why and when (#343)", async () => {
  const response = entityGoneResponse(tombstone);
  assertEquals(response?.status, 410);
  const body = await response!.json();
  assertEquals(body.code, "entity_removed");
  assertEquals(body.reason, "removed_at_source");
  assertEquals(body.removedAt, "2026-10-10T01:50:40.454Z");
  assertEquals(body.meetingId, tombstone.meeting_id);
});

Deno.test("a live entity or one never exported is not gone", () => {
  assertEquals(entityGoneResponse(null), null);
  assertEquals(entityGoneResponse({ ...tombstone, op: "upsert" }), null);
});

Deno.test("an old tombstone without a reason is still 410", async () => {
  const response = entityGoneResponse({ ...tombstone, reason: undefined, meeting_id: undefined });
  const body = await response!.json();
  assertEquals(response!.status, 410);
  assertEquals(body.reason, null);
  assertEquals("meetingId" in body, false);
});
