import { GemeenteOplossingenExtractor } from "../src/gemeenteoplossingen/extractor.ts";
import { normalizeAllmanakParties, normalizeAllmanakPersons } from "../src/allmanak/normalize.ts";
import { normalizeGoDocuments, normalizeGoMeeting } from "../src/gemeenteoplossingen/normalize.ts";
import type { DocumentEntity, GemeenteOplossingenSourceDefinition } from "../src/types.ts";

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

  urlForKey(key: string): string {
    return `http://storage.test/${key}`;
  }
}

function makeSource(): GemeenteOplossingenSourceDefinition {
  return {
    key: "goirle",
    label: "Goirle",
    supplier: "gemeenteoplossingen",
    organizationType: "gemeente",
    allmanakId: 30496,
    cbsId: "GM0785",
    baseUrl: "https://raad.goirle.nl/api",
    apiVersion: "v1",
  };
}

Deno.test("GO + Allmanak normalizers produce canonical ids", async () => {
  const source = makeSource();
  const rawMeetings = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/go_meetings.json", import.meta.url)),
  ) as unknown[];
  const meeting = normalizeGoMeeting(source, rawMeetings[0] as never);
  const documents = normalizeGoDocuments(source, meeting);

  assert(meeting.id === "meeting:gemeenteoplossingen:gemeente:goirle:123", "meeting id");
  assert(meeting.committee === "committee:gemeenteoplossingen:gemeente:goirle:10", "committee id");
  assert(
    documents.some((doc) => doc.id.endsWith(":500")),
    "includes meeting-level document",
  );
  assert(
    documents.some((doc) => doc.id.endsWith(":501")),
    "includes agenda document",
  );
  assert(
    documents[0].original_url?.includes("/v1/meetings/123/documents/") ?? false,
    "original_url should be derived from baseUrl",
  );

  const rawSeats = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/allmanak_parties.json", import.meta.url)),
  ) as Array<{ zetels?: unknown[] }>;
  const rawPersons = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/allmanak_persons.json", import.meta.url)),
  ) as unknown;

  const parties = normalizeAllmanakParties(source, rawSeats[0].zetels as never);
  const fixturePeople = (rawPersons as any)[0].functies[0].functie.medewerkers.map(
    (m: any) => m.persoon,
  ) as never;
  const persons = normalizeAllmanakPersons(source, fixturePeople);

  assert(parties.length === 2, "expected 2 parties");
  assert(parties[0].id.startsWith("party:allmanak:gemeente:goirle:"), "party id supplier allmanak");
  assert(persons.length === 2, "expected 2 persons");
  assert(
    persons[0].id.startsWith("person:allmanak:gemeente:goirle:"),
    "person id supplier allmanak",
  );
  assert(persons[0].gender === "Man", "gender detection for Dhr.");
  assert(persons[1].gender === "Vrouw", "gender detection for Mw.");
});

Deno.test("normalizeGoMeeting handles GO 'date' field with embedded time", () => {
  const source = makeSource();
  // Real-shape API response: full datetime in `date`, no separate startTime.
  const meeting = normalizeGoMeeting(source, {
    id: 42,
    date: "2026-05-19 19:30:00",
    dmu: { id: 10, name: "Gemeenteraad" },
    documents: [{ id: 900, filename: "stuk.pdf" }],
  } as never);

  assert(
    meeting.start_date === "2026-05-19T19:30:00",
    `expected ISO start_date, got ${meeting.start_date}`,
  );
  assert(
    !Number.isNaN(new Date(meeting.start_date).getTime()),
    "start_date must be parseable as Date",
  );

  const documents = normalizeGoDocuments(source, meeting);
  assert(
    documents[0].last_discussed_at === "2026-05-19T19:30:00",
    "document last_discussed_at propagates parseable datetime",
  );
});

Deno.test("GemeenteOplossingenExtractor emits committees, parties, persons, meetings and materialized documents", async () => {
  const source = makeSource();
  const storage = new FakeStorage();

  const committeesFixture = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/go_committees.json", import.meta.url)),
  );
  const meetingsFixture = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/go_meetings.json", import.meta.url)),
  );
  const partiesFixture = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/allmanak_parties.json", import.meta.url)),
  );
  const personsFixture = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/allmanak_persons.json", import.meta.url)),
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

    // basic signal presence check for importer fetches
    const hasSignal = Boolean(init && typeof init === "object" && "signal" in init);
    assert(hasSignal, `expected AbortSignal for fetch ${url}`);

    if (url.includes("rest-api.allmanak.nl")) {
      if (url.includes("select=zetels")) {
        return new Response(JSON.stringify(partiesFixture), { status: 200 });
      }
      return new Response(JSON.stringify(personsFixture), { status: 200 });
    }

    if (url.endsWith("/v1/dmus")) {
      return new Response(JSON.stringify(committeesFixture), { status: 200 });
    }

    if (url.includes("/v1/meetings?")) {
      return new Response(JSON.stringify(meetingsFixture), { status: 200 });
    }

    if (url.includes("/v1/meetings/123/documents/")) {
      return new Response(new TextEncoder().encode("PDF bytes"), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    const extractor = new GemeenteOplossingenExtractor(
      () =>
        ({
          listCommittees: async () => committeesFixture,
          listMeetingsByDateRange: async () => meetingsFixture,
        }) as never,
      // rely on fetch stubs inside AllmanakClient
      new (await import("../src/allmanak/client.ts")).AllmanakClient("v1"),
      async () => storage as never,
    );

    const bundle = await extractor.extractForDateRange(source, "2025-01-14", "2025-01-15");

    assert(bundle.committees?.length === 2, "expected committees");
    assert(bundle.parties?.length === 2, "expected parties");
    assert(bundle.persons?.length === 2, "expected persons");
    assert(bundle.meetings.length === 1, "expected one meeting");
    assert(bundle.documents.length === 2, "expected two documents");
    assert(bundle.stats.downloaded_count === 2, "expected both documents downloaded/materialized");

    const doc = bundle.documents[0] as DocumentEntity;
    assert(doc.media_urls?.[0]?.url?.includes("/documents/"), "expected storage-backed media url");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
