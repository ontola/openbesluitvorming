// Isolate from the local .env (loaded as a side effect of the blocklist
// lookup in materializeDocument): keep ops-DB writes in a temp file and make
// sure a configured extraction service cannot reroute the local test paths.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));
// A single space: loadLocalEnv only fills unset/empty vars, and the URL is trimmed before use.
Deno.env.set("WOOZI_EXTRACTION_SERVICE_URL", " ");

import {
  GemeenteOplossingenExtractor,
  splitDateRange,
} from "../src/gemeenteoplossingen/extractor.ts";
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

  // 19:30 is a wall-clock reading in Europe/Amsterdam, and May is CEST, so the
  // instant is two hours earlier (#203). It used to be stamped 19:30 UTC.
  assert(
    meeting.start_date === "2026-05-19T17:30:00Z",
    `expected the Dutch wall clock as a UTC instant, got ${meeting.start_date}`,
  );
  assert(
    !Number.isNaN(new Date(meeting.start_date).getTime()),
    "start_date must be parseable as Date",
  );

  const documents = normalizeGoDocuments(source, meeting);
  assert(
    documents[0].last_discussed_at === "2026-05-19T17:30:00Z",
    "document last_discussed_at propagates parseable datetime",
  );
});

Deno.test("splitDateRange splits a multi-year window into N-month chunks", () => {
  const chunks = splitDateRange("2021-06-01", "2026-08-31", 6);
  // Jun 2021 → Aug 2026 ≈ 5 years 3 months → 11 chunks of 6 months
  assert(chunks.length === 11, `expected 11 chunks, got ${chunks.length}`);
  assert(
    chunks[0][0] === "2021-06-01",
    `first chunk should start at requested from-date, got ${chunks[0][0]}`,
  );
  assert(
    chunks[chunks.length - 1][1] === "2026-08-31",
    `last chunk should end at requested to-date, got ${chunks[chunks.length - 1][1]}`,
  );
  // Chunks must be contiguous and non-overlapping.
  for (let i = 1; i < chunks.length; i += 1) {
    const prevEnd = new Date(`${chunks[i - 1][1]}T00:00:00Z`).getTime();
    const thisStart = new Date(`${chunks[i][0]}T00:00:00Z`).getTime();
    assert(
      thisStart - prevEnd === 86_400_000,
      `chunk ${i} should start exactly one day after chunk ${i - 1} (${chunks[i - 1][1]} → ${chunks[i][0]})`,
    );
  }
});

Deno.test("splitDateRange returns the original range when chunkMonths<=0", () => {
  const chunks = splitDateRange("2024-01-01", "2026-12-31", 0);
  assert(
    chunks.length === 1 && chunks[0][0] === "2024-01-01" && chunks[0][1] === "2026-12-31",
    "expected pass-through",
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

Deno.test("GemeenteOplossingenExtractor fails the run when no meeting chunk can be listed", async () => {
  const source = makeSource();
  const originalFetch = globalThis.fetch;
  // Allmanak still answers: a run that only reaches Allmanak must not pass
  // for a successful import of the council site.
  globalThis.fetch = async () => new Response("[]", { status: 200 });
  try {
    const extractor = new GemeenteOplossingenExtractor(
      () =>
        ({
          listCommittees: async () => {
            throw new Error("invalid peer certificate: UnknownIssuer");
          },
          listMeetingsByDateRange: async () => {
            throw new Error("invalid peer certificate: UnknownIssuer");
          },
        }) as never,
      new (await import("../src/allmanak/client.ts")).AllmanakClient("v1"),
      async () => new FakeStorage() as never,
    );

    let thrown: unknown;
    try {
      await extractor.extractForDateRange(source, "2024-01-01", "2025-12-31");
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Error, "expected the run to fail");
    assert(
      thrown.message.includes("Failed to list GO meetings 2024-01-01") &&
        thrown.message.includes("UnknownIssuer"),
      `expected the first chunk's failure as the error, got ${thrown.message}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GemeenteOplossingenExtractor keeps a run partial when only some chunks fail", async () => {
  const source = makeSource();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]", { status: 200 });
  try {
    let calls = 0;
    const extractor = new GemeenteOplossingenExtractor(
      () =>
        ({
          listCommittees: async () => [],
          listMeetingsByDateRange: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error("HTTP 500");
            }
            return [];
          },
        }) as never,
      new (await import("../src/allmanak/client.ts")).AllmanakClient("v1"),
      async () => new FakeStorage() as never,
    );

    const bundle = await extractor.extractForDateRange(source, "2024-01-01", "2025-12-31");
    assert(calls > 1, "expected more than one chunk");
    assert(bundle.stats.issue_count === 1, "expected the failed chunk as one issue");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
