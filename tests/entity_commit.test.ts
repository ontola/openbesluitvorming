import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import type { MeetingEntity } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("buildEntityCommitEvent wraps a meeting in a commit envelope", async () => {
  const meeting: MeetingEntity = {
    id: "meeting:notubiz:gemeente:haarlem:123",
    type: "Meeting",
    name: "Raadscommissie Financien",
    classification: ["Agenda"],
    start_date: "2025-01-14T19:30:00+01:00",
    end_date: "2025-01-14T21:30:00+01:00",
    last_discussed_at: "2025-01-14T19:30:00+01:00",
    organization: "organization:nl:gemeente:haarlem",
    committee: "committee:notubiz:gemeente:haarlem:999",
    agenda: ["agenda_item:notubiz:gemeente:haarlem:1"],
    attachment: ["document:notubiz:gemeente:haarlem:2"],
    source_info: {
      supplier: "notubiz",
      source: "haarlem",
      organization_type: "gemeente",
      canonical_id: "123",
      canonical_iri: "https://api.notubiz.nl/events/meetings/123",
    },
    raw: {
      id: 123,
    },
  };

  const event = await buildEntityCommitEvent(meeting, {
    time: "2026-03-31T12:00:00.000Z",
  });

  assert(event.specversion === "1.0", "expected CloudEvents specversion");
  assert(event.type === "entity.commit", "expected entity.commit event type");
  assert(event.source === "/woozi/notubiz/haarlem", "expected event source");
  assert(event.subject === meeting.id, "expected subject to equal entity id");
  assert(event.datacontenttype === "application/json", "expected JSON content type");
  assert(event.data.entity_type === "Meeting", "expected Meeting entity type");
  assert(event.data.entity_id === meeting.id, "expected matching entity id");
  assert(event.data.op === "upsert", "expected upsert op");
  assert(event.data.mode === "replace", "expected replace mode");
  assert(event.data.schema_name === "Meeting", "expected Meeting schema name");
  assert(event.data.schema_version === "v1alpha1", "expected schema version");
  assert(event.data.content_hash.startsWith("sha256:"), "expected content hash with sha256 prefix");
  assert(event.data.payload?.type === "Meeting", "expected Meeting payload");
  assert(
    !("raw" in (event.data.payload as unknown as Record<string, unknown>)),
    "payload should not contain raw",
  );
});
