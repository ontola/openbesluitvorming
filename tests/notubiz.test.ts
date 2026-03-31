import { NotubizMeetingExtractor } from "../src/notubiz/extractor.ts";
import { getNotubizSource } from "../src/sources/notubiz.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test({
  name: "extracts one day of public Notubiz meetings for Haarlem",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const source = getNotubizSource("haarlem");
    const extractor = new NotubizMeetingExtractor();

    const meetings = await extractor.extractForDateRange(source, "2025-01-14", "2025-01-15");

    assert(Array.isArray(meetings), "expected meetings array");
    assert(meetings.length > 0, "expected at least one public meeting");

    for (const meeting of meetings) {
      assert(meeting.type === "Meeting", "meeting type should be Meeting");
      assert(meeting.id.startsWith("meeting:notubiz:haarlem:"), "meeting id should be namespaced");
      assert(meeting.name.length > 0, "meeting should have a name");
      assert(meeting.start_date.length > 0, "meeting should have a start_date");
      assert(meeting.classification.includes("Agenda"), "meeting should classify as Agenda");
      assert(meeting.source_info.source === "haarlem", "meeting source should be haarlem");
      assert(meeting.source_info.supplier === "notubiz", "meeting supplier should be notubiz");
    }
  },
});

Deno.test({
  name: "emits entity.commit events for one day of public Notubiz meetings for Haarlem",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const source = getNotubizSource("haarlem");
    const extractor = new NotubizMeetingExtractor();

    const events = await extractor.extractCommitEventsForDateRange(
      source,
      "2025-01-14",
      "2025-01-15",
    );

    assert(Array.isArray(events), "expected events array");
    assert(events.length > 0, "expected at least one entity.commit event");

    for (const event of events) {
      assert(event.specversion === "1.0", "expected CloudEvents specversion");
      assert(event.type === "entity.commit", "expected entity.commit type");
      assert(event.source === "/woozi/notubiz/haarlem", "expected event source");
      assert(event.subject.startsWith("meeting:notubiz:haarlem:"), "expected meeting subject");
      assert(event.data.entity_type === "Meeting", "expected Meeting entity type");
      assert(event.data.op === "upsert", "expected upsert op");
      assert(event.data.mode === "replace", "expected replace mode");
      assert(event.data.content_hash.startsWith("sha256:"), "expected content hash");
      assert(event.data.payload?.type === "Meeting", "expected Meeting payload");
      assert(event.data.payload?.source_info.source === "haarlem", "expected payload source");
    }
  },
});
