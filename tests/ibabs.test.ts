import { IbabsMeetingExtractor } from "../src/ibabs/extractor.ts";
import { __test__ as ibabsClientTest } from "../src/ibabs/client.ts";
import { getIbabsSource } from "../src/sources/ibabs.ts";
import { normalizeIbabsDocuments, normalizeIbabsMeeting } from "../src/ibabs/normalize.ts";
import type { DocumentEntity } from "../src/types.ts";

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

Deno.test("iBabs SOAP parsers extract meeting types and meetings from fixture XML", async () => {
  const meetingTypesXml = await Deno.readTextFile(
    new URL("./fixtures/ibabs_meetingtypes_response.xml", import.meta.url),
  );
  const meetingsXml = await Deno.readTextFile(
    new URL("./fixtures/ibabs_meetings_response.xml", import.meta.url),
  );

  const meetingTypes = ibabsClientTest.parseMeetingTypesXml(meetingTypesXml);
  const meetings = ibabsClientTest.parseMeetingsXml(meetingsXml);

  assert(meetingTypes.length === 2, "expected two meeting types");
  assert(meetingTypes[0].Description === "Raadscommissie Ruimte", "expected meeting type label");
  assert(meetings.length === 1, "expected one meeting");
  assert(
    meetings[0].MeetingItems?.[0]?.Documents?.[0]?.Id === "doc-43",
    "expected nested documents",
  );
});

Deno.test("normalizeIbabsMeeting and normalizeIbabsDocuments use the canonical Woozi id grammar", async () => {
  const source = getIbabsSource("amstelveen");
  const meetingsXml = await Deno.readTextFile(
    new URL("./fixtures/ibabs_meetings_response.xml", import.meta.url),
  );
  const meetingTypesXml = await Deno.readTextFile(
    new URL("./fixtures/ibabs_meetingtypes_response.xml", import.meta.url),
  );

  const meetingTypes = new Map(
    ibabsClientTest
      .parseMeetingTypesXml(meetingTypesXml)
      .map((meetingType) => [
        meetingType.Id,
        meetingType.Description ?? meetingType.Meetingtype ?? meetingType.Id,
      ]),
  );
  const rawMeeting = ibabsClientTest.parseMeetingsXml(meetingsXml)[0];

  const meeting = normalizeIbabsMeeting(source, rawMeeting, meetingTypes);
  const documents = normalizeIbabsDocuments(source, meeting);

  assert(
    meeting.id === "meeting:ibabs:gemeente:amstelveen:meeting-123",
    "meeting id should use supplier + bestuurslaag + key + native id",
  );
  assert(
    meeting.organization === "organization:nl:gemeente:amstelveen",
    "organization id should use the canonical NL bestuurslaag scope",
  );
  assert(
    meeting.committee === "committee:ibabs:gemeente:amstelveen:11",
    "committee id should use the canonical Woozi grammar",
  );
  assert(
    meeting.agenda?.[0] === "agenda_item:ibabs:gemeente:amstelveen:agenda-7",
    "agenda item ids should use the canonical Woozi grammar",
  );
  assert(documents.length === 2, "expected direct and agenda documents");
  assert(
    documents[0].id === "document:ibabs:gemeente:amstelveen:doc-42",
    "document ids should use the canonical Woozi grammar",
  );
});

Deno.test("IbabsMeetingExtractor materializes fixture meetings and documents", async () => {
  const source = getIbabsSource("amstelveen");
  const storage = new FakeStorage();
  const meetingsXml = await Deno.readTextFile(
    new URL("./fixtures/ibabs_meetings_response.xml", import.meta.url),
  );
  const meetingTypesXml = await Deno.readTextFile(
    new URL("./fixtures/ibabs_meetingtypes_response.xml", import.meta.url),
  );

  const extractor = new IbabsMeetingExtractor(
    {
      getMeetingTypes: async () => ibabsClientTest.parseMeetingTypesXml(meetingTypesXml),
      listMeetingsByDateRange: async () => ibabsClientTest.parseMeetingsXml(meetingsXml),
      downloadDocument: async (document: DocumentEntity) =>
        new TextEncoder().encode(`Inhoud voor ${document.source_info.canonical_id}`),
    } as never,
    async () => storage as never,
  );

  const bundle = await extractor.extractForDateRange(source, "2025-01-14", "2025-01-15");

  assert(bundle.meetings.length === 1, "expected one meeting");
  assert(bundle.documents.length === 2, "expected two documents");
  assert(bundle.stats.downloaded_count === 2, "expected both documents to be materialized");
  assert(
    bundle.documents[0].media_urls?.[0]?.url?.includes("/documents/ibabs/gemeente/amstelveen/"),
    "expected iBabs storage keys to follow the same scoped layout as Notubiz",
  );
});
