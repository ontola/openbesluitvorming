import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import { canonicalRecordingId } from "../src/ids.ts";
import {
  compactEntityPayload,
  projectEntityCommitToQuickwitDocuments,
} from "../src/quickwit/project.ts";
import { getNotubizSource } from "../src/sources/index.ts";
import type { RecordingEntity } from "../src/types.ts";

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

function recordingFixture(overrides: Partial<RecordingEntity> = {}): RecordingEntity {
  const source = getNotubizSource("haarlem");
  return {
    id: canonicalRecordingId(source, 397530),
    type: "Recording",
    name: "Raadsvergadering 10 juni 2026",
    classification: ["Video"],
    media_type: "video",
    meeting: "meeting:notubiz:gemeente:haarlem:1502813",
    start_date: "2026-06-10T18:37:18Z",
    duration_seconds: 4469,
    platform: "notubiz",
    player_url: "https://haarlem.raadsinformatie.nl/vergadering/1502813/RAAD",
    media_url: "https://api.notubiz.nl/media/download?folder=Haarlem&file=raad.mp4",
    content_type: "video/mp4",
    transcript_language: "nl",
    transcript_kind: "asr",
    chapters: [{ start_seconds: 99, end_seconds: 480, title: "Vaststellen van de agenda" }],
    speakers: [{ start_seconds: 96, end_seconds: 480, name: "Halsema, F.", party: "GroenLinks" }],
    segments: [
      {
        start_seconds: 10,
        end_seconds: 120,
        text: "Ik open deze vergadering van de gemeenteraad.",
      },
      { start_seconds: 120, end_seconds: 240, text: "Aan de orde is de woningbouwopgave." },
    ],
    derived_content: {
      transcript_key: "recordings/notubiz/gemeente/haarlem/x/v1/transcript.json",
      segment_count: 2,
      speaker_count: 1,
      chapter_count: 1,
    },
    organization: "organization:nl:gemeente:haarlem",
    source_info: { supplier: "notubiz", source: "haarlem", organization_type: "gemeente" },
    raw: {},
    ...overrides,
  };
}

Deno.test("a recording id is scoped like every other entity id", () => {
  const source = getNotubizSource("haarlem");
  assertEquals(
    canonicalRecordingId(source, 397530),
    "recording:notubiz:gemeente:haarlem:397530",
    "canonical recording id",
  );
});

Deno.test("a recording projects into a searchable Quickwit document", async () => {
  const recording = recordingFixture();
  const event = await buildEntityCommitEvent(recording);
  const projected = projectEntityCommitToQuickwitDocuments(event);

  assertEquals(projected.length, 1, "phase A emits one row per recording, not one per segment");

  const [document] = projected;
  assertEquals(document.entity_type, "Recording", "projected entity type");
  assertEquals(document.parent_entity_id, recording.meeting, "recording hangs off its meeting");
  assert(document.content?.includes("woningbouwopgave"), "spoken text is searchable");
  assert(document.content?.includes("Halsema"), "speaker name is searchable");
  assert(document.content?.includes("Vaststellen van de agenda"), "chapter title is searchable");
  assertEquals(document.start_date, "2026-06-10T18:37:18Z", "sorts on the recording date");
});

Deno.test("an unparseable recording date degrades to undefined instead of losing the entity", async () => {
  // A mapped datetime field that fails to parse makes Quickwit discard the
  // whole document with a successful-looking ingest response, so the recording
  // would silently vanish from search.
  const event = await buildEntityCommitEvent(
    recordingFixture({ start_date: "onzin", last_discussed_at: undefined }),
  );
  const [document] = projectEntityCommitToQuickwitDocuments(event);

  assertEquals(document.start_date, undefined, "bad date falls back to undefined");
  assertEquals(document.entity_type, "Recording", "the recording is still indexed");
});

Deno.test("the stored payload carries the timeline but not the transcript", async () => {
  const recording = recordingFixture();
  const payload = compactEntityPayload(recording) as Record<string, unknown>;

  assert(!("segments" in payload), "segments must not be inlined in the stored payload");
  assert(!("raw" in payload), "raw supplier data stays out of the payload");
  assertEquals(
    (payload.derived_content as { transcript_key?: string }).transcript_key,
    recording.derived_content?.transcript_key,
    "the transcript is reachable through its object storage key",
  );
  assertEquals((payload.chapters as unknown[]).length, 1, "chapters survive compaction");
  assertEquals((payload.speakers as unknown[]).length, 1, "speakers survive compaction");
  assertEquals(payload.player_url, recording.player_url, "player url survives compaction");
});
