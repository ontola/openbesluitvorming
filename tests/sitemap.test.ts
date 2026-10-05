import {
  buildSourceSitemaps,
  collectSitemapEntries,
  entityDay,
  entityUrl,
  renderSitemap,
  renderSitemapIndex,
  SITEMAP_FILE_PATTERN,
  windowStart,
} from "../src/exports/sitemap.ts";
import type { ExportChangeRecord } from "../src/types.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\n  expected: ${expectedJson}\n  actual:   ${actualJson}`);
  }
}

function record(
  entityId: string,
  entityType: string,
  payload: Record<string, unknown>,
  time = "2026-09-30T04:15:00.123Z",
): ExportChangeRecord {
  return {
    seq: 0,
    op: "upsert",
    time,
    entity_id: entityId,
    entity_type: entityType,
    source_key: "ermelo",
    supplier: "notubiz",
    payload,
  };
}

Deno.test("an entity is dated like the search index dates it", () => {
  assertEquals(
    entityDay(record("meeting:x:1", "Meeting", { start_date: "2026-03-05T19:30:00+01:00" })),
    "2026-03-05",
    "a meeting by its start date",
  );
  assertEquals(
    entityDay(
      record("document:x:1", "Document", {
        last_discussed_at: "2026-02-01",
        date_modified: "2026-09-01",
      }),
    ),
    "2026-02-01",
    "a document by when it was discussed, not when it was modified",
  );
  assertEquals(
    entityDay(record("document:x:2", "Document", { date_modified: "2026-04-02T10:00:00Z" })),
    "2026-04-02",
    "falling back to the modification date",
  );
  assertEquals(entityDay(record("document:x:3", "Document", {})), undefined, "no date, no day");
  assertEquals(
    entityDay(record("document:x:4", "Document", { last_discussed_at: "onzin" })),
    undefined,
    "junk is not a date",
  );
});

Deno.test("the window is twelve months back and cuts on the entity's date", () => {
  assertEquals(windowStart(new Date("2026-10-05T12:00:00Z"), 12), "2025-10-05", "a year back");
  const entries = collectSitemapEntries(
    [
      record("meeting:x:1", "Meeting", { start_date: "2026-05-01T10:00:00Z" }),
      record("document:x:old", "Document", { last_discussed_at: "2024-01-01" }),
      record(
        "document:x:new",
        "Document",
        { last_discussed_at: "2026-06-01" },
        "2026-10-01T00:00:00Z",
      ),
      record("motion:x:1", "Motion", { last_discussed_at: "2026-06-01" }),
      record("document:x:undated", "Document", {}),
    ],
    "2025-10-05",
  );
  assertEquals(
    entries.map((entry) => entry.entityId),
    ["document:x:new", "meeting:x:1"],
    "meetings and documents in the window, most recently changed first",
  );
});

Deno.test("an address carries the encoded id, and the XML is escaped", () => {
  assertEquals(
    entityUrl("https://openbesluitvorming.nl/", "document:ibabs:gemeente:soest:a-b"),
    "https://openbesluitvorming.nl/?view=document%3Aibabs%3Agemeente%3Asoest%3Aa-b",
    "no double slash, colons encoded",
  );
  const xml = renderSitemap("https://example.nl", [
    { entityId: "document:x:a&b<c", lastmod: "2026-09-30T04:15:00Z", date: "2026-09-01" },
  ]);
  assertEquals(xml.includes("a%26b%3Cc"), true, "reserved characters are percent-encoded");
  assertEquals(xml.includes("<lastmod>2026-09-30T04:15:00Z</lastmod>"), true, "lastmod w/o millis");
  assertEquals(
    xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'),
    true,
    "namespace",
  );
});

Deno.test("a source is split into files of at most maxUrls and named in order", () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    entityId: `document:x:${index}`,
    lastmod: `2026-09-0${5 - index}T00:00:00Z`,
    date: "2026-09-01",
  }));
  const files = buildSourceSitemaps("https://example.nl", "ermelo", entries, 2);
  assertEquals(
    files.map((file) => [file.name, file.urlCount]),
    [
      ["ermelo-1.xml", 2],
      ["ermelo-2.xml", 2],
      ["ermelo-3.xml", 1],
    ],
    "2 + 2 + 1",
  );
  assertEquals(files[0].lastmod, "2026-09-05T00:00:00Z", "a file's lastmod is its newest entry");
  assertEquals(buildSourceSitemaps("https://example.nl", "leeg", []), [], "nothing in the window");
  assertEquals(
    files.every((file) => SITEMAP_FILE_PATTERN.test(file.name)),
    true,
    "names match what the web server accepts",
  );
  assertEquals(SITEMAP_FILE_PATTERN.test("../secret.xml"), false, "no path traversal");
  assertEquals(SITEMAP_FILE_PATTERN.test("index.xml"), false, "the index has its own route");
});

Deno.test("the index lists each file under /sitemaps/", () => {
  const xml = renderSitemapIndex("https://openbesluitvorming.nl", [
    { name: "ermelo-1.xml", lastmod: "2026-09-05T00:00:00Z" },
  ]);
  assertEquals(
    xml.includes(
      "<sitemap><loc>https://openbesluitvorming.nl/sitemaps/ermelo-1.xml</loc><lastmod>2026-09-05T00:00:00Z</lastmod></sitemap>",
    ),
    true,
    "one entry per file",
  );
});
