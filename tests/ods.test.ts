// Isolate from the local .env (the blocklist lookup loads it): ops-DB writes
// go to a temp file, and no extraction service reroutes the documents.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));
Deno.env.set("WOOZI_EXTRACTION_SERVICE_URL", " ");

import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { downloadFeedDocument, OdsExtractor } from "../src/ods/extractor.ts";
import { OdsFeedClient, type OdsFeedPage, type OdsSnapshotPage } from "../src/ods/feed.ts";
import { OdsMirror } from "../src/ods/mirror.ts";
import { isPublicHttpsUrl, normalizeOdsMeeting, odsNativeId } from "../src/ods/normalize.ts";
import { feedHasNews } from "../src/ods/poller.ts";
import { parseOdsSources, toOdsCatalogEntry } from "../src/ods/sources.ts";
import type { ExtractedEntity, OdsSourceDefinition } from "../src/types.ts";

/** Commissie Ruimte of the Eemdal demo (OpenMeeting's own test data), as an
 * ODS 0.0.3 feed would serve it: a snapshot of 15 records, then a feed page
 * that changes the raadsvoorstel and withdraws the bewonersbrief. */
const fixture: { snapshot: OdsSnapshotPage; feed: OdsFeedPage } = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/ods/eemdal-commissie-ruimte.json", import.meta.url)),
);

const FEED_URL = "https://eemdal.example/ori/v1";
const source: OdsSourceDefinition = {
  key: "eemdal",
  label: "Eemdal",
  supplier: "ods",
  organizationType: "gemeente",
  allmanakId: 0,
  organisatiecode: "gm9999",
  feedUrl: FEED_URL,
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

/** A feed that serves the fixture: the snapshot, then the feed page once
 * `published` is set, then nothing. `reject` makes it refuse every cursor. */
function fakeFeed(options: { published?: boolean; reject?: boolean } = {}) {
  const requests: URL[] = [];
  const empty = (cursor: string): OdsFeedPage => ({
    records: [],
    cursor,
    head: options.published ? fixture.feed.head : 15,
    hasMore: false,
  });
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    assertEquals(url.searchParams.get("organisatiecode"), "gm9999");
    const cursor = url.searchParams.get("cursor");
    if (url.pathname.endsWith("/snapshot")) return Response.json(fixture.snapshot);
    if (options.reject && cursor) {
      return Response.json({ status: 400, title: "Ongeldige cursor" }, { status: 400 });
    }
    if (cursor === fixture.snapshot.feedCursor) {
      return Response.json(options.published ? fixture.feed : empty(cursor));
    }
    return Response.json(empty(cursor ?? fixture.snapshot.feedCursor));
  }) as typeof fetch;
  return { fetcher, requests, options };
}

Deno.test("sources come from the environment", () => {
  const [config] = parseOdsSources(
    JSON.stringify([
      { key: "eemdal", label: "Eemdal", organisatiecode: "GM9999", feedUrl: `${FEED_URL}/` },
    ]),
  );
  assertEquals(config.organizationType, "gemeente");
  assertEquals(config.organisatiecode, "gm9999");
  assertEquals(config.feedUrl, FEED_URL);
  const entry = toOdsCatalogEntry(config);
  assertEquals(entry.sourceRef, "ods:gemeente:eemdal");
  assertEquals(entry.supplier, "ods");
  assertEquals(entry.odsFeedUrl, FEED_URL);

  for (const bad of [
    "{}",
    JSON.stringify([{ key: "Eemdal", organisatiecode: "gm9999", feedUrl: FEED_URL }]),
    JSON.stringify([{ key: "eemdal", organisatiecode: "9999", feedUrl: FEED_URL }]),
    JSON.stringify([{ key: "eemdal", organisatiecode: "gm9999", feedUrl: "ftp://x" }]),
    JSON.stringify([
      { key: "eemdal", organisatiecode: "gm9999", feedUrl: FEED_URL, organizationType: "land" },
    ]),
  ]) {
    let threw = false;
    try {
      parseOdsSources(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
  assertEquals(parseOdsSources(""), []);
});

Deno.test("sync: snapshot first, then the feed from the snapshot's feedCursor", async () => {
  const storage = new MemoryStorage();
  const mirror = new OdsMirror(storage, "eemdal");
  const feed = fakeFeed();
  const client = new OdsFeedClient(FEED_URL, "gm9999", feed.fetcher);

  const first = await mirror.sync(client);
  assert(first.snapshot);
  assertEquals(first.applied, 15);
  const index = await mirror.index();
  assertEquals(index.vergaderingen.size, 1);
  assertEquals(index.agendapunten.size, 7);
  assertEquals(index.informatieobjecten.size, 7);
  let state = await mirror.state();
  assertEquals(state.cursor, fixture.snapshot.feedCursor);
  assertEquals(state.pendingMeetings, ["om-26"]);
  assertEquals(
    feed.requests.map((url) => url.pathname.split("/").pop()),
    ["snapshot", "feed"],
  );

  feed.options.published = true;
  const second = await mirror.sync(client);
  assert(!second.snapshot);
  assertEquals(second.applied, 2);
  state = await mirror.state();
  assertEquals(state.cursor, fixture.feed.cursor);
  assertEquals((await mirror.index()).informatieobjecten.size, 6);
  const removals = await mirror.pendingRemovals();
  assertEquals(removals.length, 1);
  assertEquals(removals[0].op, "delete");
  assertEquals(removals[0].verwijderreden, "ingetrokken");
  assertEquals(removals[0].meetings, ["om-26"]);
});

Deno.test("sync: replaying a page changes nothing", async () => {
  const storage = new MemoryStorage();
  const mirror = new OdsMirror(storage, "eemdal");
  await mirror.sync(new OdsFeedClient(FEED_URL, "gm9999", fakeFeed().fetcher));
  await mirror.acknowledgeImported(["om-26"]);
  const before = new Map(storage.objects);
  // A crash after writing the page and before saving the cursor: the same
  // records again. Not newer than what we hold, so skipped.
  const replay = fakeFeed();
  const mirrorAgain = new OdsMirror(storage, "eemdal");
  storage.objects.delete("ods/eemdal/state.json");
  await mirrorAgain.sync(new OdsFeedClient(FEED_URL, "gm9999", replay.fetcher));
  for (const [key, value] of before) {
    if (key.endsWith("state.json")) continue;
    assertEquals(storage.objects.get(key), value, key);
  }
  assertEquals((await mirrorAgain.state()).pendingMeetings ?? [], []);
});

Deno.test("sync: a refused cursor starts over from the snapshot", async () => {
  const storage = new MemoryStorage();
  const mirror = new OdsMirror(storage, "eemdal");
  await mirror.sync(new OdsFeedClient(FEED_URL, "gm9999", fakeFeed().fetcher));
  const refusing = fakeFeed({ reject: true });
  // The fake keeps refusing, so the sync goes round until its page cap; what
  // matters is that it went back to the snapshot and kept what we hold.
  await mirror.sync(new OdsFeedClient(FEED_URL, "gm9999", refusing.fetcher));
  assert(refusing.requests.some((url) => url.pathname.endsWith("/snapshot")));
  assertEquals((await mirror.index()).agendapunten.size, 7);
});

Deno.test("a vergadering becomes our meeting, committee and documents", async () => {
  const storage = new MemoryStorage();
  const mirror = new OdsMirror(storage, "eemdal");
  await mirror.sync(new OdsFeedClient(FEED_URL, "gm9999", fakeFeed().fetcher));
  const index = await mirror.index();
  const { meeting, documents, committee } = await normalizeOdsMeeting(
    source,
    index.vergaderingen.get("om-26")!,
    index,
  );
  assertEquals(meeting.id, "meeting:ods:gemeente:eemdal:om-26");
  assertEquals(meeting.name, "Commissie Ruimte");
  assertEquals(meeting.start_date, "2026-10-30T19:30:00.000Z");
  assertEquals(meeting.status, "EventConfirmed");
  assertEquals(meeting.organization, "organization:nl:gemeente:eemdal");
  assertEquals(
    meeting.agenda?.map((item) => item.number),
    ["1", "2", "3", "4", "5", "6", "7"],
  );
  assertEquals(meeting.agenda?.[1].classification, "hamerstuk");
  assertEquals(meeting.agenda?.[3].documents?.length, 3);
  assertEquals(committee?.name, "Commissie Ruimte");
  assertEquals(meeting.committee, committee?.id);
  assertEquals(documents.length, 7);
  assertEquals(new Set(meeting.attachment), new Set(documents.map((d) => d.id)));
  for (const doc of documents) {
    assertEquals(doc.is_referenced_by, meeting.id);
    // The demo has no files: the omschrijving is what we index.
    assert(doc.md_text?.[0], `${doc.name} has text`);
  }
});

Deno.test("an id that is not a plain token becomes a stable hash", async () => {
  assertEquals(await odsNativeId("vg-2026-0412"), "vg-2026-0412");
  assertMatch(await odsNativeId("did:ad:test:26"), /^[0-9a-f]{20}$/);
  assertEquals(await odsNativeId("did:ad:test:26"), await odsNativeId("did:ad:test:26"));
});

Deno.test("extractor: the window, then what the feed changed, then the retraction", async () => {
  const storage = new MemoryStorage();
  const feed = fakeFeed();
  const extractor = new OdsExtractor(async () => storage, feed.fetcher);

  const entities: ExtractedEntity[] = [];
  const first = await extractor.extractForDateRange(source, "2026-10-30", "2026-10-30", {
    onEntity: (entity) => void entities.push(entity),
  });
  assertEquals(first.stats.meeting_count, 1);
  assertEquals(first.stats.document_count, 7);
  assertEquals(first.stats.issue_count, 0);
  assertEquals(entities.filter((e) => e.type === "Committee").length, 1);
  assertEquals(first.retractions, undefined);
  const key = first.documents[0].derived_content?.markdown_key;
  assert(key, "the text is stored where the reader looks for it");
  assert((await storage.getObjectText(key)).length > 0);

  // The feed moves on. A run for a day without meetings still imports the
  // meeting it changed, and hands back the withdrawn document.
  feed.options.published = true;
  const second = await extractor.extractForDateRange(source, "2026-11-22", "2026-11-22");
  assertEquals(second.stats.meeting_count, 1);
  assertEquals(second.stats.document_count, 6);
  assert(
    second.documents.some((doc) => doc.name.endsWith("(gewijzigd)")),
    "the changed raadsvoorstel",
  );
  assertEquals(second.retractions?.entries, [
    {
      entityId: "document:ods:gemeente:eemdal:om-39",
      entityType: "Document",
      reason: "removed_at_source",
      meetingId: "meeting:ods:gemeente:eemdal:om-26",
    },
  ]);

  // Not retracted yet: the next run offers it again. Once done, it is gone.
  const third = await extractor.extractForDateRange(source, "2026-11-22", "2026-11-22");
  assertEquals(third.stats.meeting_count, 0);
  assertEquals(third.retractions?.entries.length, 1);
  await third.retractions!.done(["document:ods:gemeente:eemdal:om-39"]);
  const fourth = await extractor.extractForDateRange(source, "2026-11-22", "2026-11-22");
  assertEquals(fourth.retractions, undefined);
});

Deno.test("extractor: a feed that cannot be read leaves what we hold importable", async () => {
  const storage = new MemoryStorage();
  await new OdsExtractor(async () => storage, fakeFeed().fetcher).extractForDateRange(
    source,
    "2026-10-30",
    "2026-10-30",
  );
  const down = (async () => new Response("kapot", { status: 404 })) as typeof fetch;
  const bundle = await new OdsExtractor(async () => storage, down).extractForDateRange(
    source,
    "2026-10-30",
    "2026-10-30",
  );
  assertEquals(bundle.stats.meeting_count, 1);
  assert(bundle.issues.some((issue) => issue.severity === "warning"));
});

Deno.test("a bestandsurl that would point the worker inward is refused", async () => {
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

  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://raad.eemdal.nl/")) {
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/secret" } });
    }
    return new Response("should not get here");
  }) as typeof fetch;
  let error = "";
  try {
    await downloadFeedDocument("https://raad.eemdal.nl/stuk.pdf", fetcher);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  assertMatch(error, /non-public address/);
});

Deno.test("poller: news only when the feed has records after our cursor", async () => {
  const storage = new MemoryStorage();
  const entry = toOdsCatalogEntry(
    parseOdsSources(
      JSON.stringify([{ key: "eemdal", organisatiecode: "gm9999", feedUrl: FEED_URL }]),
    )[0],
  );
  const feed = fakeFeed();
  // Never synced: the snapshot is news.
  assert(await feedHasNews(entry, storage, feed.fetcher));
  await new OdsMirror(storage, "eemdal").sync(new OdsFeedClient(FEED_URL, "gm9999", feed.fetcher));
  assert(!(await feedHasNews(entry, storage, feed.fetcher)));
  feed.options.published = true;
  assert(await feedHasNews(entry, storage, feed.fetcher));
  assertEquals(feed.requests.at(-1)?.searchParams.get("limit"), "1");
});
