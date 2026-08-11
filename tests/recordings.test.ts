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

Deno.test("media_only skips the document and motion passes", async () => {
  // The point of the mode: a backfill runs over history we already hold, so
  // re-downloading those PDFs would cost far more than the recordings are
  // worth. Meetings are still scanned (their detail carries the agenda offsets)
  // but not re-emitted — rewriting hundreds of thousands of unchanged entities
  // would be the same waste in a different place.
  const { NotubizMeetingExtractor } = await import("../src/notubiz/extractor.ts");
  const source = getNotubizSource("nunspeet");

  const meetingDetail = {
    meeting: {
      id: 1412355,
      permission_group: "public",
      plannings: [{ start_date: "2026-04-01 19:30:00", end_date: "2026-04-01 22:00:00" }],
      url: "https://nunspeet.raadsinformatie.nl/vergadering/1412355/Raad",
      agenda_items: [
        {
          id: 900,
          start_offset: "0",
          end_offset: "480",
          type_data: { attributes: [{ id: 1, value: "Opening" }] },
        },
      ],
      documents: [{ id: 77, url: "https://example.test/stuk.pdf" }],
    },
  };

  const calls: string[] = [];
  const client = {
    getOrganizationAttributes: () => {
      calls.push("attributes");
      return Promise.resolve({ attributes: {} });
    },
    listEvents: (_org: number, _from: string, _to: string, page: number) => {
      calls.push(`events:${page}`);
      return Promise.resolve(
        page === 1
          ? { events: [{ id: 1412355, type: "meeting", permission_group: "public" }] }
          : { events: [] },
      );
    },
    getMeeting: () => {
      calls.push("meeting");
      return Promise.resolve(meetingDetail);
    },
    listMedia: () => {
      calls.push("media");
      return Promise.resolve([
        { id: 392881, event_id: 1412355, media_type: "video", subtitles: null },
      ]);
    },
    downloadSubtitles: () => Promise.resolve(""),
    downloadDocument: () => {
      calls.push("downloadDocument");
      return Promise.resolve(new Uint8Array());
    },
    listModules: () => {
      calls.push("listModules");
      return Promise.resolve([]);
    },
    listModuleItems: () => Promise.resolve([]),
  };

  const emitted: string[] = [];
  // deno-lint-ignore no-explicit-any
  const extractor = new NotubizMeetingExtractor(client as any, () => Promise.resolve(undefined));
  const bundle = await extractor.extractForDateRange(source, "2026-04-01", "2026-04-01", {
    executionMode: "media_only",
    onEntity: (entity) => {
      emitted.push(entity.type);
    },
  });

  assertEquals(emitted, ["Recording"], "only the recording is emitted");
  assert(!calls.includes("downloadDocument"), `no document was downloaded: ${calls.join(",")}`);
  assert(!calls.includes("listModules"), `no motion registry was read: ${calls.join(",")}`);
  assertEquals(bundle.stats.recording_count, 1, "the recording is counted");
  assertEquals(bundle.stats.document_count, 0, "no documents");
  assertEquals(bundle.stats.meeting_count, 1, "the meeting is still counted as scanned");
});
