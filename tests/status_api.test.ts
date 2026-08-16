import { __test__ } from "../web/status_api.ts";
import type { SourceStatus, StatusResponse, SupplierStatus } from "../src/types.ts";
import type { SourceRunStatus, SupplierRunWindow } from "../src/ops/store.ts";

const { buildStatusResponse, sanitizeErrorMessage } = __test__;

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

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const WINDOW_HOURS = 36;

function hoursAgo(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

function build(options: {
  sources?: SourceRunStatus[];
  supplierWindows?: SupplierRunWindow[];
  indexActivity?: Map<string, { latestContentDate?: string; lastIndexedAt?: string }> | null;
}): StatusResponse {
  return buildStatusResponse({
    runStatus: {
      sources: options.sources ?? [],
      supplierWindows: options.supplierWindows ?? [],
    },
    indexActivity: options.indexActivity === undefined ? new Map() : options.indexActivity,
    now: NOW,
    windowHours: WINDOW_HOURS,
  });
}

function source(response: StatusResponse, key: string): SourceStatus {
  const found = response.sources.find((row) => row.sourceKey === key);
  assert(found, `expected source "${key}" in the response`);
  return found;
}

function supplier(response: StatusResponse, name: string): SupplierStatus {
  const found = response.suppliers.find((row) => row.supplier === name);
  assert(found, `expected supplier "${name}" in the response`);
  return found;
}

Deno.test("every catalog source is reported, including ones we never import", () => {
  const response = build({});

  assertEquals(response.sources.length, 330, "the whole catalog should be one call");
  // Dongen is withdrawn from importing but its data still answers searches.
  assertEquals(
    source(response, "dongen").state,
    "not_implemented",
    "a withdrawn source is not 'failing'",
  );
  assertEquals(
    source(response, "soest").state,
    "never_imported",
    "an implemented source with no runs at all",
  );
});

Deno.test("a source with a recent success is ok even when last night failed", () => {
  const response = build({
    sources: [
      {
        sourceKey: "soest",
        supplier: "ibabs",
        lastRunAt: hoursAgo(2),
        lastRunStatus: "failed",
        lastErrorMessage: "one bad night",
        lastSuccessAt: hoursAgo(26),
      },
    ],
  });

  const soest = source(response, "soest");
  // The scheduler re-imports seven days either side, so this fixes itself.
  assertEquals(soest.state, "ok", "a single failure over a fresh success is not a problem");
  assertEquals(soest.lastRunStatus, "failed", "the failure is still reported");
  assertEquals(soest.lastErrorMessage, "one bad night", "and so is its reason");
});

Deno.test("a source stops being ok once no success falls inside the window", () => {
  const failing = build({
    sources: [
      {
        sourceKey: "soest",
        supplier: "ibabs",
        lastRunAt: hoursAgo(12),
        lastRunStatus: "failed",
        lastErrorMessage: "iBabs blocks requests from this host",
        lastSuccessAt: hoursAgo(240),
      },
    ],
  });
  assertEquals(source(failing, "soest").state, "failing", "ten days without a success");

  const stale = build({
    sources: [
      {
        sourceKey: "soest",
        supplier: "ibabs",
        lastRunAt: hoursAgo(12),
        lastRunStatus: "queued",
        lastSuccessAt: hoursAgo(240),
      },
    ],
  });
  assertEquals(
    stale.sources.find((row) => row.sourceKey === "soest")?.state,
    "stale",
    "not failed",
  );
});

Deno.test("a partial run counts as a success", () => {
  const response = build({
    sources: [
      {
        sourceKey: "soest",
        supplier: "ibabs",
        lastRunAt: hoursAgo(2),
        lastRunStatus: "partial",
        lastSuccessAt: hoursAgo(2),
      },
    ],
  });

  assertEquals(
    source(response, "soest").state,
    "ok",
    "one unreadable PDF must not mark a municipality as not updating",
  );
});

Deno.test("a supplier failing every run reads as down, with how long it has lasted", () => {
  const response = build({
    sources: [
      {
        sourceKey: "soest",
        supplier: "ibabs",
        lastRunAt: hoursAgo(12),
        lastRunStatus: "failed",
        lastErrorMessage:
          'iBabs blocks requests from this host (403 "The request is blocked" for https://wcf.ibabs.eu/api/Public.svc).',
        lastSuccessAt: hoursAgo(264),
      },
      {
        sourceKey: "aalten",
        supplier: "ibabs",
        lastRunAt: hoursAgo(12),
        lastRunStatus: "failed",
        lastSuccessAt: hoursAgo(248),
      },
      {
        sourceKey: "west_betuwe",
        supplier: "notubiz",
        lastRunAt: hoursAgo(12),
        lastRunStatus: "succeeded",
        lastSuccessAt: hoursAgo(12),
      },
    ],
    supplierWindows: [
      {
        supplier: "ibabs",
        runCount: 332,
        succeededCount: 0,
        failedCount: 332,
        lastErrorMessage:
          'iBabs blocks requests from this host (403 "The request is blocked" for https://wcf.ibabs.eu/api/Public.svc).',
      },
      { supplier: "notubiz", runCount: 254, succeededCount: 253, failedCount: 1 },
    ],
  });

  const ibabs = supplier(response, "ibabs");
  assertEquals(ibabs.state, "down", "332 attempts, 0 successes");
  assertEquals(ibabs.label, "iBabs", "the supplier is named the way it names itself");
  assertEquals(ibabs.failedCount, 332, "the window counts are passed through");
  // The most recent success across all its sources: the outage started here.
  assertEquals(ibabs.lastSuccessAt, hoursAgo(248), "how long the supplier has been out");
  assert(ibabs.lastErrorMessage?.includes("The request is blocked"), "with the reason");

  assertEquals(supplier(response, "notubiz").state, "ok", "one failure in 254 is not degraded");
  assertEquals(
    supplier(response, "notubiz").lastErrorMessage,
    undefined,
    "a healthy supplier reports no error",
  );
});

Deno.test("a supplier is only judged once it has genuinely been tried", () => {
  const response = build({
    supplierWindows: [{ supplier: "parlaeus", runCount: 3, succeededCount: 0, failedCount: 3 }],
  });

  assertEquals(
    supplier(response, "parlaeus").state,
    "degraded",
    "under the meaningful-runs floor a total failure is not called down",
  );
});

Deno.test("supplier state is idle when nothing ran in the window", () => {
  assertEquals(supplier(build({}), "ibabs").state, "idle", "no runs at all");
});

Deno.test("index activity is merged per source and is optional", () => {
  const withActivity = build({
    indexActivity: new Map([
      [
        "soest",
        {
          latestContentDate: "2026-08-20T13:30:00.000Z",
          lastIndexedAt: "2026-08-16T00:09:59.000Z",
        },
      ],
    ]),
  });
  assertEquals(
    source(withActivity, "soest").latestContentDate,
    "2026-08-20T13:30:00.000Z",
    "a meeting already on the agenda for next week",
  );
  assertEquals(withActivity.indexActivityAvailable, true, "the index answered");

  const withoutActivity = build({ indexActivity: null });
  assertEquals(
    withoutActivity.indexActivityAvailable,
    false,
    "search being unreachable is reported, not hidden",
  );
  assertEquals(
    withoutActivity.sources.length,
    330,
    "and the import half of the answer still arrives",
  );
});

Deno.test("published error messages drop query strings", () => {
  // Parlaeus carries its session id as `rid` in the query string.
  assertEquals(
    sanitizeErrorMessage("GET https://parlaeus.example/api?rid=s3cret&fn=agenda failed with 500"),
    "GET https://parlaeus.example/api?… failed with 500",
    "a session id must not reach a public response",
  );
  assertEquals(
    sanitizeErrorMessage("timed out\n  after 180s"),
    "timed out after 180s",
    "whitespace is collapsed",
  );
  assertEquals(sanitizeErrorMessage("   "), undefined, "an empty message is omitted");
  assert(
    (sanitizeErrorMessage("x".repeat(500)) ?? "").length <= 300,
    "messages are capped at 300 characters",
  );
});

Deno.test("sources are sorted by label, suppliers by key", () => {
  const response = build({});
  const labels = response.sources.map((row) => row.label);
  const sorted = [...labels].sort((left, right) => left.localeCompare(right, "nl"));
  assertEquals(labels, sorted, "sources come out in Dutch alphabetical order");
  assertEquals(
    response.suppliers.map((row) => row.supplier),
    ["gemeenteoplossingen", "ibabs", "notubiz", "parlaeus"],
    "one entry per supplier present in the catalog",
  );
});

Deno.test("an organization merged away by a herindeling reads as discontinued", () => {
  const response = build({
    sources: [
      {
        sourceKey: "weesp",
        supplier: "notubiz",
        lastRunAt: hoursAgo(12),
        lastRunStatus: "failed",
        lastErrorMessage: "no meetings found",
        lastSuccessAt: hoursAgo(40_000),
      },
    ],
  });

  const weesp = source(response, "weesp");
  // Weesp became part of Amsterdam on 24 March 2022. Nothing is coming, so
  // this must not read as an import someone should go and fix.
  assertEquals(weesp.state, "discontinued", "not 'failing'");
  assertEquals(weesp.discontinuedAt, "2022-03-24", "with the date it ceased to exist");
  assertEquals(
    weesp.succeededBy,
    { cbsId: "GM0363", label: "Amsterdam", sourceKey: "amsterdam" },
    "and where its business went",
  );
});

Deno.test("a successor we do not import is still named, without a source key", () => {
  // Five sources are succeeded by Land van Cuijk, which is not in the catalog.
  const boxmeer = source(build({}), "boxmeer");
  assertEquals(boxmeer.state, "discontinued", "merged into Land van Cuijk in 2022");
  assertEquals(
    boxmeer.succeededBy,
    { cbsId: "GM1982", label: "Land van Cuijk", sourceKey: undefined },
    "naming who took over is useful even when we hold none of their data",
  );
});

Deno.test("exactly the organizations CBS no longer lists are discontinued", () => {
  const discontinued = build({})
    .sources.filter((row) => row.state === "discontinued")
    .map((row) => row.sourceKey)
    .sort();

  // Verified against CBS "Gebieden in Nederland": the year each code last
  // appears in. Borger-Odoorn is deliberately absent -- it still exists, and
  // only looked discontinued while its CBS code was stored lowercased.
  assertEquals(
    discontinued,
    [
      "beemster",
      "binnenmaas",
      "boxmeer",
      "brielle",
      "cuijk",
      "grave",
      "mill_en_st_hubert",
      "sint_anthonis",
      "weesp",
      "westvoorne",
    ],
    "ten organizations, matching the count ORI ran into",
  );
});

Deno.test("a discontinued organization is not counted against its source system", () => {
  const response = build({
    supplierWindows: [{ supplier: "notubiz", runCount: 200, succeededCount: 200, failedCount: 0 }],
  });

  const notubiz = supplier(response, "notubiz");
  const notubizSources = response.sources.filter((row) => row.supplier === "notubiz");
  const stillRunning = notubizSources.filter(
    (row) => row.state !== "discontinued" && row.state !== "not_implemented",
  ).length;
  assertEquals(
    notubiz.sourceCount,
    stillRunning,
    "a supplier is not marked short for organizations that no longer exist",
  );
});
