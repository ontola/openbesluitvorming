import { NotubizMeetingExtractor } from "../src/notubiz/extractor.ts";
import { getNotubizSource } from "../src/sources/notubiz.ts";
import type { ExtractionBundle, NotubizOrganizationAttributes } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeStorage {
  private readonly objects = new Map<string, Uint8Array>();

  async hasObject(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async putObject(key: string, body: Uint8Array): Promise<{ url: string }> {
    this.objects.set(key, body);
    return { url: `http://storage.test/${key}` };
  }

  async getObjectText(key: string): Promise<string> {
    const bytes = this.objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : "";
  }

  urlForKey(key: string): string {
    return `http://storage.test/${key}`;
  }
}

function makeMeeting(id: number, documentId: number): Record<string, unknown> {
  return {
    id,
    inactive: false,
    canceled: false,
    plannings: [
      {
        start_date: `2025-01-${String(id).padStart(2, "0")}T19:30:00+01:00`,
        end_date: `2025-01-${String(id).padStart(2, "0")}T21:00:00+01:00`,
      },
    ],
    attributes: [
      { id: "title", value: `Vergadering ${id}` },
      { id: "location", value: "Raadzaal" },
    ],
    documents: [
      {
        id: documentId,
        title: `Document ${documentId}`,
        self: `api.notubiz.nl/document/${documentId}`,
        version: 1,
        last_modified: "2025-01-16 11:03:37",
        versions: [
          {
            file_name: `document-${documentId}.txt`,
            mime_type: "text/plain",
            file_size: 1200,
          },
        ],
      },
    ],
    agenda_items: [],
  };
}

Deno.test("NotubizMeetingExtractor emits incremental progress while work is still running", async () => {
  const source = getNotubizSource("haarlem");
  const storage = new FakeStorage();
  const progressSnapshots: ExtractionBundle["stats"][] = [];

  const extractor = new NotubizMeetingExtractor(
    {
      getOrganizationAttributes: async (): Promise<NotubizOrganizationAttributes> => ({
        attributes: {
          title: "Titel",
          location: "Locatie",
        },
      }),
      listEvents: async () => ({
        events: [
          { id: 1, permission_group: "public" },
          { id: 2, permission_group: "public" },
        ],
        pagination: {
          has_more_pages: false,
        },
      }),
      getMeeting: async (meetingId: number) => ({
        meeting: makeMeeting(meetingId, 100 + meetingId),
      }),
      downloadDocument: async () => new TextEncoder().encode("Dit is de inhoud van het document."),
    } as never,
    async () => storage as never,
  );

  const previousMeetingConcurrency = Deno.env.get("WOOZI_MEETING_CONCURRENCY");
  const previousDocumentConcurrency = Deno.env.get("WOOZI_DOCUMENT_CONCURRENCY");
  Deno.env.set("WOOZI_MEETING_CONCURRENCY", "1");
  Deno.env.set("WOOZI_DOCUMENT_CONCURRENCY", "1");

  try {
    const extraction = await extractor.extractForDateRange(source, "2025-01-01", "2025-01-02", {
      onProgress: (stats) => {
        progressSnapshots.push({ ...stats });
      },
    });

    assert(progressSnapshots.length >= 4, "expected per-item progress snapshots");
    assert(
      progressSnapshots.some(
        (snapshot) => snapshot.meeting_count === 1 && snapshot.document_count === 0,
      ),
      "expected a meeting-only progress update before document processing finished",
    );
    assert(
      progressSnapshots.some((snapshot) => snapshot.document_count === 1),
      "expected a document progress update before the end of the run",
    );
    const finalSnapshot = progressSnapshots.at(-1);
    assert(finalSnapshot?.meeting_count === 2, "expected final meeting count");
    assert(finalSnapshot?.document_count === 2, "expected final document count");
    assert(finalSnapshot?.downloaded_count === 2, "expected final download count");
    assert(extraction.stats.document_count === 2, "extraction should finish with both documents");
  } finally {
    if (previousMeetingConcurrency === undefined) {
      Deno.env.delete("WOOZI_MEETING_CONCURRENCY");
    } else {
      Deno.env.set("WOOZI_MEETING_CONCURRENCY", previousMeetingConcurrency);
    }
    if (previousDocumentConcurrency === undefined) {
      Deno.env.delete("WOOZI_DOCUMENT_CONCURRENCY");
    } else {
      Deno.env.set("WOOZI_DOCUMENT_CONCURRENCY", previousDocumentConcurrency);
    }
  }
});
