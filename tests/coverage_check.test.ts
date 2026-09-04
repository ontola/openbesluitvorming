// The ops store opens its database at import time from WOOZI_KV_PATH, so the
// path is set before the store is imported (same pattern as
// tests/ops_ingest_status.test.ts).
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { assertEquals } from "jsr:@std/assert";
import { __test__, compareCoverage } from "../src/coverage/check.ts";
import { latestCoverageChecks, recordCoverageCheck } from "../src/ops/store.ts";
import { getNotubizSource } from "../src/sources/index.ts";
import { __test__ as statusTest } from "../web/status_api.ts";

Deno.test("coverage compares what the supplier lists against what we hold", () => {
  const comparison = compareCoverage(
    ["document:x:1", "document:x:2", "document:x:3"],
    ["document:x:2", "document:x:9"],
  );
  assertEquals(comparison.supplierDocuments, 3);
  assertEquals(comparison.heldDocuments, 1);
  assertEquals(comparison.missingDocuments, 2);
  assertEquals(comparison.missingSample, ["document:x:1", "document:x:3"]);
  // What we hold beyond the supplier's listing is not a gap.
  assertEquals(compareCoverage([], ["document:x:9"]).missingDocuments, 0);
});

Deno.test("a Notubiz listing counts meeting documents and register attachments alike", async () => {
  const source = getNotubizSource("ermelo");
  const registerItems = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/notubiz_ermelo_ingekomen_stukken.json", import.meta.url),
    ),
  ).items;
  const fakeClient = {
    getOrganizationAttributes: () => Promise.resolve({ attributes: {} }),
    listEvents: (_org: number, _from: string, _to: string, page: number) =>
      Promise.resolve(
        page === 1
          ? {
              events: [
                { id: 501, permission_group: "public" },
                { id: 502, permission_group: "private" },
              ],
              pagination: { has_more_pages: false },
            }
          : { events: [] },
      ),
    getMeeting: (id: number) =>
      Promise.resolve({
        meeting: {
          id,
          title: "Raad",
          plannings: [{ start_date: "2026-01-14 19:30:00" }],
          gremium: { name: "Gemeenteraad" },
          agenda_items: [
            {
              id: 9001,
              type_data: { title: "Opening" },
              documents: [
                { id: 700, url: "https://api.notubiz.nl/document/700/1", title: "Agenda" },
              ],
            },
          ],
          documents: [],
        },
      }),
    listModules: () =>
      Promise.resolve([
        { id: 1, name: "Ingekomen stukken" },
        { id: 6, name: "Moties" },
      ]),
    listModuleItems: (_org: number, moduleId: number) =>
      Promise.resolve(moduleId === 1 ? registerItems : []),
  };

  const listing = await __test__.listNotubiz(
    source,
    "2026-01-01",
    "2026-12-31",
    // deno-lint-ignore no-explicit-any
    fakeClient as any,
  );
  assertEquals(listing.meetings, 1, "only the public meeting is fetched");
  assertEquals(listing.registerEntries, 2, "both register items are listed");
  assertEquals(listing.warnings, []);
  // 1 agenda document + 7 + 1 register attachments
  assertEquals(listing.documentIds.size, 9);
  assertEquals(listing.documentIds.has("document:notubiz:gemeente:ermelo:700"), true);
  assertEquals(listing.documentIds.has("document:notubiz:gemeente:ermelo:16387622"), true);
});

Deno.test("a recorded check surfaces on the status response as coverage", async () => {
  await recordCoverageCheck({
    source_key: "ermelo",
    checked_at: "2026-09-07T05:00:00.000Z",
    window_from: "2025-09-07",
    window_to: "2026-09-07",
    supplier_documents: 1547,
    held_documents: 170,
    missing_documents: 1377,
    missing_sample: ["document:notubiz:gemeente:ermelo:15155760"],
    supplier_meetings: 68,
    register_entries: 540,
    warnings: 0,
  });
  // A newer check replaces the older one in the latest view.
  await recordCoverageCheck({
    source_key: "ermelo",
    checked_at: "2026-09-14T05:00:00.000Z",
    window_from: "2025-09-14",
    window_to: "2026-09-14",
    supplier_documents: 1600,
    held_documents: 1580,
    missing_documents: 20,
    missing_sample: [],
    supplier_meetings: 70,
    register_entries: 560,
    warnings: 2,
  });
  const latest = await latestCoverageChecks();
  const ermelo = latest.find((row) => row.source_key === "ermelo");
  assertEquals(ermelo?.checked_at, "2026-09-14T05:00:00.000Z");
  assertEquals(ermelo?.missing_sample, []);

  const response = statusTest.buildStatusResponse({
    runStatus: { sources: [], supplierWindows: [] },
    indexActivity: null,
    coverageChecks: latest,
    now: Date.parse("2026-09-14T12:00:00Z"),
    windowHours: 36,
  });
  const source = response.sources.find((row) => row.sourceKey === "ermelo");
  assertEquals(source?.coverage?.supplierDocuments, 1600);
  assertEquals(source?.coverage?.ratio, 0.988);
  assertEquals(source?.coverage?.lowerBound, true, "two failed requests make it a lower bound");
  const other = response.sources.find((row) => row.sourceKey === "dongen");
  assertEquals(other?.coverage, undefined, "no check, no field");
});
