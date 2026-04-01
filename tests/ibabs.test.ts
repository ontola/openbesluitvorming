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

Deno.test("iBabs SOAP parsers fail when the service returns Status ERR", () => {
  const deniedMeetingTypesXml =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><GetMeetingtypesResponse xmlns="http://tempuri.org/"><GetMeetingtypesResult xmlns:a="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Common"><Message xmlns="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Base">IPaddress 82.172.191.240 has no access to site amstelveen!</Message><Status xmlns="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Base">ERR</Status><a:Meetingtypes xmlns:b="http://schemas.datacontract.org/2004/07/iBabsWCFObjects"/></GetMeetingtypesResult></GetMeetingtypesResponse></s:Body></s:Envelope>';
  const deniedMeetingsXml =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><GetMeetingsByDateRangeResponse xmlns="http://tempuri.org/"><GetMeetingsByDateRangeResult xmlns:a="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Public"><Message xmlns="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Base">IPaddress 82.172.191.240 has no access to site amstelveen!</Message><Status xmlns="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Base">ERR</Status><a:Meetings/></GetMeetingsByDateRangeResult></GetMeetingsByDateRangeResponse></s:Body></s:Envelope>';

  let meetingTypesError: unknown;
  let meetingsError: unknown;

  try {
    ibabsClientTest.parseMeetingTypesXml(deniedMeetingTypesXml);
  } catch (error) {
    meetingTypesError = error;
  }

  try {
    ibabsClientTest.parseMeetingsXml(deniedMeetingsXml);
  } catch (error) {
    meetingsError = error;
  }

  assert(
    meetingTypesError instanceof Error &&
      meetingTypesError.message.includes("has no access to site amstelveen"),
    "expected GetMeetingtypes ERR response to throw the SOAP message",
  );
  assert(
    meetingsError instanceof Error &&
      meetingsError.message.includes("has no access to site amstelveen"),
    "expected GetMeetingsByDateRange ERR response to throw the SOAP message",
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
    meeting.agenda?.[0]?.id === "agenda_item:ibabs:gemeente:amstelveen:agenda-7",
    "agenda item ids should use the canonical Woozi grammar",
  );
  assert(
    meeting.agenda?.[0]?.documents?.[0]?.id === "document:ibabs:gemeente:amstelveen:doc-43",
    "agenda items should retain linked document refs",
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
