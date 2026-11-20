// Isolate from the local .env (the blocklist lookup loads it): ops-DB writes
// go to a temp file, and no extraction service reroutes the documents.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));
Deno.env.set("WOOZI_EXTRACTION_SERVICE_URL", " ");

import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { OpenMeetingExtractor, downloadPublishedDocument } from "../src/openmeeting/extractor.ts";
import {
  isPublicHttpsUrl,
  normalizePublishedMeeting,
  type PublishedMeeting,
  validatePublishedMeeting,
} from "../src/openmeeting/normalize.ts";
import { amsterdamDay, PublishedMeetings } from "../src/openmeeting/published.ts";
import { parseOpenMeetingSources, toOpenMeetingCatalogEntry } from "../src/openmeeting/sources.ts";
import type {
  ExtractedEntity,
  IngestRunRecord,
  OpenMeetingSourceDefinition,
} from "../src/types.ts";
import { createPublishHandler } from "../web/publish_api.ts";

/** The publication of Commissie Ruimte in the Eemdal demo, as OpenMeeting's
 * `publication()` makes it (ontola/openmeeting, test/publish_test.dart with
 * OM_WRITE_PUBLICATION). Both sides test this same JSON. */
const fixture: PublishedMeeting = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/openmeeting/commissie-ruimte.json", import.meta.url)),
);

const TOKEN = "een-token-van-minstens-24-tekens";
const source: OpenMeetingSourceDefinition = {
  key: "eemdal",
  label: "Eemdal",
  supplier: "openmeeting",
  organizationType: "gemeente",
  allmanakId: 0,
};

class MemoryStorage {
  readonly objects = new Map<string, Uint8Array>();
  urlForKey(key: string): string {
    return `http://storage.test/woozi/${key}`;
  }
  async hasObject(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async putObject(key: string, body: Uint8Array): Promise<{ url: string }> {
    this.objects.set(key, body);
    return { url: this.urlForKey(key) };
  }
  async getObjectText(key: string): Promise<string> {
    const bytes = this.objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : "";
  }
  async getObjectBytes(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }
  async listObjects(options: { prefix?: string; startAfter?: string; maxKeys?: number }) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .filter((key) => !options.startAfter || key > options.startAfter)
      .sort();
    const max = options.maxKeys ?? 1000;
    return { keys: keys.slice(0, max), isTruncated: keys.length > max };
  }
  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

Deno.test("the OpenMeeting export is a valid publication", () => {
  assertEquals(validatePublishedMeeting(fixture), []);
});

Deno.test("a publication that would point the worker inward is refused", () => {
  for (const url of [
    "http://raad.eemdal.nl/stuk.pdf",
    "https://quickwit:7280/api",
    "https://10.0.0.2/stuk.pdf",
    "https://[::1]/stuk.pdf",
    "https://user:pw@raad.eemdal.nl/stuk.pdf",
    "https://minio.internal/woozi/x",
  ]) {
    assert(!isPublicHttpsUrl(url), url);
  }
  assert(isPublicHttpsUrl("https://raad.eemdal.nl/stukken/1.pdf"));

  const bad = structuredClone(fixture) as unknown as Record<string, any>;
  bad.agenda[3].documents[0].original_url = "https://localhost/x.pdf";
  delete bad.name;
  bad.start_date = "2026-10-30 19:30";
  const problems = validatePublishedMeeting(bad);
  assert(
    problems.some((p) => p.startsWith("name")),
    problems.join("; "),
  );
  assert(
    problems.some((p) => p.startsWith("start_date")),
    problems.join("; "),
  );
  assert(
    problems.some((p) => p.includes("original_url")),
    problems.join("; "),
  );
});

Deno.test("a published meeting becomes our meeting, committee and documents", async () => {
  const { meeting, documents, committee } = await normalizePublishedMeeting(source, fixture);
  assertMatch(meeting.id, /^meeting:openmeeting:gemeente:eemdal:[0-9a-f]{20}$/);
  assertEquals(meeting.name, "Commissie Ruimte");
  assertEquals(meeting.status, "EventConfirmed");
  assertEquals(meeting.organization, "organization:nl:gemeente:eemdal");
  assertEquals(meeting.agenda?.length, 7);
  assertEquals(meeting.agenda?.[0].is_heading, true);
  assertEquals(meeting.agenda?.[1].classification, "hamerstuk");
  assertEquals(committee?.name, "Commissie Ruimte");
  assertEquals(meeting.committee, committee?.id);
  // Seven documents on Commissie Ruimte; one entity each, all linked.
  assertEquals(documents.length, 7);
  assertEquals(new Set(meeting.attachment), new Set(documents.map((d) => d.id)));
  for (const doc of documents) {
    assertEquals(doc.is_referenced_by, meeting.id);
    // The demo has no files: the text OpenMeeting holds is what we index.
    assert(doc.md_text?.[0], `${doc.name} has text`);
  }
  // Same input, same ids: publishing again updates instead of doubling.
  const again = await normalizePublishedMeeting(source, fixture);
  assertEquals(again.meeting.id, meeting.id);
});

Deno.test("the extractor imports what was published in the window", async () => {
  const storage = new MemoryStorage();
  const store = new PublishedMeetings(storage);
  await store.put("eemdal", fixture, new Date());
  const later = {
    ...structuredClone(fixture),
    id: "did:ad:test:later",
    start_date: "2026-12-01T19:00:00Z",
  };
  await store.put("eemdal", later, new Date());
  // Another source's meetings are not ours.
  await store.put("elders", { ...fixture, id: "did:ad:other" }, new Date());

  const entities: ExtractedEntity[] = [];
  const day = amsterdamDay(fixture.start_date);
  const bundle = await new OpenMeetingExtractor(async () => storage).extractForDateRange(
    source,
    day,
    day,
    { onEntity: (entity) => void entities.push(entity) },
  );
  assertEquals(bundle.stats.meeting_count, 1);
  assertEquals(bundle.stats.document_count, 7);
  assertEquals(bundle.stats.issue_count, 0);
  assertEquals(entities.filter((e) => e.type === "Committee").length, 1);
  const docs = bundle.documents;
  const key = docs[0].derived_content?.markdown_key;
  assert(key, "the text is stored where the reader looks for it");
  assert((await storage.getObjectText(key)).length > 0);
});

Deno.test("a redirect to an inside address is not followed", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://raad.eemdal.nl/")) {
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/secret" } });
    }
    return new Response("should not get here");
  }) as typeof fetch;
  let error = "";
  try {
    await downloadPublishedDocument("https://raad.eemdal.nl/stuk.pdf", fetcher);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  assertMatch(error, /non-public address/);
});

Deno.test("sources come from the environment, tokens never reach the catalog", () => {
  const [config] = parseOpenMeetingSources(
    JSON.stringify([{ key: "eemdal", label: "Eemdal", token: TOKEN }]),
  );
  assertEquals(config.organizationType, "gemeente");
  const entry = toOpenMeetingCatalogEntry(config);
  assertEquals(entry.sourceRef, "openmeeting:gemeente:eemdal");
  assertEquals(entry.supplier, "openmeeting");
  assert(!JSON.stringify(entry).includes(TOKEN));

  for (const bad of [
    "{}",
    JSON.stringify([{ key: "Eemdal", token: TOKEN }]),
    JSON.stringify([{ key: "eemdal", token: "kort" }]),
    JSON.stringify([{ key: "eemdal", token: TOKEN, organizationType: "land" }]),
  ]) {
    let threw = false;
    try {
      parseOpenMeetingSources(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
  assertEquals(parseOpenMeetingSources(""), []);
});

function publishHandler(storage: MemoryStorage, runs: string[][], busy = false) {
  return createPublishHandler({
    sources: [{ key: "eemdal", label: "Eemdal", organizationType: "gemeente", token: TOKEN }],
    storage: async () => storage,
    catalogEntry: () => source,
    startIngest: async (sourceRef, dateFrom, dateTo) => {
      if (busy) throw new Error("Er draait al een import");
      runs.push([sourceRef, dateFrom, dateTo]);
      return { id: "run-1", status: "queued" } as IngestRunRecord;
    },
    audit: () => {},
  });
}

function request(method: string, path: string, body?: unknown, token = TOKEN): Request {
  return new Request(`http://test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test("publish: stores the meeting and queues an import of its day", async () => {
  const storage = new MemoryStorage();
  const runs: string[][] = [];
  const handle = publishHandler(storage, runs);

  const response = await handle(request("PUT", "/api/publish/eemdal/meetings", fixture), "c");
  assertEquals(response.status, 202);
  const body = await response.json();
  assertMatch(body.meeting_id, /^meeting:openmeeting:gemeente:eemdal:/);
  assertEquals(body.run, { id: "run-1", status: "queued" });
  assertEquals(runs, [["openmeeting:gemeente:eemdal", "2026-10-30", "2026-10-30"]]);

  const stored = await handle(
    request("GET", `/api/publish/eemdal/meetings?id=${encodeURIComponent(fixture.id)}`),
    "c",
  );
  assertEquals((await stored.json()).meeting.name, "Commissie Ruimte");

  const removed = await handle(
    request("DELETE", `/api/publish/eemdal/meetings?id=${encodeURIComponent(fixture.id)}`),
    "c",
  );
  assertEquals((await removed.json()).removed, true);
  assertEquals(storage.objects.size, 0);
});

Deno.test("publish: a busy day still stores, and says the import comes later", async () => {
  const storage = new MemoryStorage();
  const response = await publishHandler(
    storage,
    [],
    true,
  )(request("PUT", "/api/publish/eemdal/meetings", fixture), "c");
  assertEquals(response.status, 202);
  const body = await response.json();
  assertEquals(body.run, null);
  assert(body.note);
  assertEquals(storage.objects.size, 1);
});

Deno.test("publish: wrong token, unknown source and a bad meeting are refused", async () => {
  const storage = new MemoryStorage();
  const handle = publishHandler(storage, []);
  const wrong = await handle(
    request("PUT", "/api/publish/eemdal/meetings", fixture, "x".repeat(32)),
    "c",
  );
  assertEquals(wrong.status, 401);
  const unknown = await handle(request("PUT", "/api/publish/elders/meetings", fixture), "c");
  assertEquals(unknown.status, 401);
  const invalid = await handle(
    request("PUT", "/api/publish/eemdal/meetings", { ...fixture, start_date: "morgen" }),
    "c",
  );
  assertEquals(invalid.status, 400);
  assert((await invalid.json()).problems.length > 0);
  assertEquals(storage.objects.size, 0);
});
