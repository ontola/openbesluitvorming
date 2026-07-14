import {
  IbabsMeetingExtractor,
  __test__ as ibabsExtractorTest,
} from "../src/ibabs/extractor.ts";
import { __test__ as ibabsClientTest } from "../src/ibabs/client.ts";
import { getIbabsSource } from "../src/sources/index.ts";
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

Deno.test("splitDateRange splits ranges on month boundaries with no overlap or gaps", () => {
  const { splitDateRange } = ibabsExtractorTest;

  const year = splitDateRange("2023-01-01", "2023-12-31", 6);
  assert(year.length === 2, "expected two 6-month chunks for a calendar year");
  assert(year[0][0] === "2023-01-01" && year[0][1] === "2023-06-30", "first chunk should end 2023-06-30");
  assert(year[1][0] === "2023-07-01" && year[1][1] === "2023-12-31", "second chunk should start 2023-07-01");

  const short = splitDateRange("2024-06-01", "2024-06-15", 6);
  assert(short.length === 1, "sub-chunk ranges stay single");
  assert(short[0][0] === "2024-06-01" && short[0][1] === "2024-06-15", "short range preserved");

  const fiveYears = splitDateRange("2020-01-01", "2024-12-31", 6);
  assert(fiveYears.length === 10, "5 years / 6 months should be 10 chunks");
  assert(fiveYears[0][0] === "2020-01-01", "first chunk starts at dateFrom");
  assert(fiveYears[fiveYears.length - 1][1] === "2024-12-31", "last chunk ends at dateTo");

  const disabled = splitDateRange("2020-01-01", "2030-01-01", 0);
  assert(disabled.length === 1, "chunkMonths=0 disables chunking");
});

Deno.test("listMeetingsAdaptive halves the chunk on SOAP timeout", async () => {
  const { listMeetingsAdaptive } = ibabsExtractorTest;
  const source = getIbabsSource("amstelveen");

  const calls: Array<{ from: string; to: string }> = [];
  const timeoutAtFullRange = "2025-01-01..2025-12-31";
  const fakeClient = {
    listMeetingsByDateRange(_source: typeof source, from: string, to: string) {
      calls.push({ from, to });
      if (`${from}..${to}` === timeoutAtFullRange) {
        const error = new Error("Signal timed out.");
        error.name = "TimeoutError";
        return Promise.reject(error);
      }
      return Promise.resolve([{ Id: `meeting-${from}` }]);
    },
  } as unknown as Parameters<typeof listMeetingsAdaptive>[0];

  const splits: Array<{ from: string; to: string }> = [];
  const meetings = await listMeetingsAdaptive(
    fakeClient,
    source,
    "2025-01-01",
    "2025-12-31",
    async (from, to) => {
      splits.push({ from, to });
    },
  );

  assert(splits.length === 1, "should report exactly one split for a single timeout");
  assert(meetings.length === 2, "halving yields meetings from each half");
  assert(calls.length === 3, "one failed full-range call + two half-range calls");
});

Deno.test("listMeetingsAdaptive stops splitting below the floor and rethrows", async () => {
  const { listMeetingsAdaptive } = ibabsExtractorTest;
  const source = getIbabsSource("amstelveen");

  const fakeClient = {
    listMeetingsByDateRange() {
      const error = new Error("Signal timed out.");
      error.name = "TimeoutError";
      return Promise.reject(error);
    },
  } as unknown as Parameters<typeof listMeetingsAdaptive>[0];

  let splits = 0;
  let caught = false;
  try {
    await listMeetingsAdaptive(
      fakeClient,
      source,
      "2025-01-01",
      "2025-01-10",
      async () => {
        splits += 1;
      },
    );
  } catch (error) {
    caught = true;
    assert(error instanceof Error && error.name === "TimeoutError", "rethrows the timeout");
  }
  assert(caught, "should bubble the error when the range is below the split floor");
  assert(splits === 0, "no split when the chunk is already short");
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
