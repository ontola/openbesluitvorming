import { expandPublicMeetingIds } from "../src/notubiz/assemblies.ts";
import { NotubizMeetingExtractor } from "../src/notubiz/extractor.ts";
import { getNotubizSource } from "../src/sources/index.ts";
import type { NotubizOrganizationAttributes } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("an assembly contributes its child meetings, a failing one reports the hole", async () => {
  // Castricum, March 2023: the events list has assemblies and members-only
  // meetings; the child meetings are only named by events/assemblies/{id}.
  const events = [
    { id: 1000243, type: "meeting", permission_group: "members" },
    { id: 1000244, type: "assembly", permission_group: "public" },
    { id: 1000245, type: "assembly", permission_group: "public" },
    { id: 1000250, type: "meeting", permission_group: "public" },
    "not an event",
  ];
  const failures: number[] = [];
  const ids = await expandPublicMeetingIds(
    events,
    {
      getAssembly: async (assemblyId: number) => {
        if (assemblyId === 1000245) {
          throw new Error("HTTP 500");
        }
        return { assembly: { meetings: [{ id: 1085396 }, { id: 1085397 }, { id: 1085396 }] } };
      },
    },
    (assemblyId) => {
      failures.push(assemblyId);
    },
  );
  assertEquals(
    ids,
    [1000244, 1085396, 1085397, 1000245, 1000250],
    "parents keep their own id, children follow, members-only and duplicates drop",
  );
  assertEquals(failures, [1000245], "a failing assembly lookup is reported, its parent kept");
});

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

function makeMeeting(id: number, documentId: number, parent?: number): Record<string, unknown> {
  return {
    id,
    inactive: false,
    canceled: false,
    parent: parent ? { id: parent, self: `api.notubiz.nl/events/${parent}` } : undefined,
    plannings: [{ start_date: "2023-03-09T20:00:00+01:00", end_date: "2023-03-09T22:30:00+01:00" }],
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
        last_modified: "2023-02-24 12:24:46",
        versions: [
          { file_name: `document-${documentId}.txt`, mime_type: "text/plain", file_size: 12 },
        ],
      },
    ],
    agenda_items: [],
  };
}

Deno.test("the extractor imports the meetings under an assembly, not only the assembly", async () => {
  const source = getNotubizSource("castricum");
  const storage = new FakeStorage();
  const fetchedMeetings: number[] = [];
  const extractor = new NotubizMeetingExtractor(
    {
      getOrganizationAttributes: async (): Promise<NotubizOrganizationAttributes> => ({
        attributes: { title: "Titel", location: "Locatie" },
      }),
      listEvents: async () => ({
        events: [{ id: 1000244, type: "assembly", permission_group: "public" }],
        pagination: { has_more_pages: false },
      }),
      getAssembly: async () => ({ assembly: { meetings: [{ id: 1085396 }, { id: 1085397 }] } }),
      getMeeting: async (meetingId: number) => {
        fetchedMeetings.push(meetingId);
        return {
          meeting: makeMeeting(
            meetingId,
            12457000 + (meetingId % 1000),
            meetingId === 1000244 ? undefined : 1000244,
          ),
        };
      },
      downloadDocument: async () => new TextEncoder().encode("Raadsvoorstel."),
    } as never,
    async () => storage as never,
  );

  const previous = Deno.env.get("WOOZI_MEETING_CONCURRENCY");
  Deno.env.set("WOOZI_MEETING_CONCURRENCY", "1");
  try {
    const extraction = await extractor.extractForDateRange(source, "2023-03-01", "2023-03-31");
    assertEquals(
      [...fetchedMeetings].sort(),
      [1000244, 1085396, 1085397],
      "the assembly and both children are fetched",
    );
    assertEquals(extraction.stats.meeting_count, 3, "three meetings imported");
    assertEquals(extraction.stats.document_count, 3, "each meeting's document imported");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_MEETING_CONCURRENCY");
    } else {
      Deno.env.set("WOOZI_MEETING_CONCURRENCY", previous);
    }
  }
});
