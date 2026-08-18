import { getDocumentCoverage } from "../web/search_api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** The coverage heatmap read as a corpus full of holes, and the corpus was fine.
 *
 * The month sub-aggregation was a `terms` over every month a source has, and a
 * `terms` returns the most *frequent* buckets rather than the ones asked for.
 * A source with 195 months of history got its busiest 60 back, whichever years
 * those fell in. Measured on production 2026-08-18: Aalsmeer was missing 135 of
 * its months, including six of the last twelve, and Alkmaar showed 0 against
 * 21.858 documents because its busiest sixty months all end in 2018.
 *
 * The fix is to filter the documents to the window before aggregating, so no
 * more than `months.length` distinct values can occur and none can be dropped.
 * This test pins the filter, because the aggregation looks correct without it.
 */
Deno.test("coverage asks only for the months it is going to show", async () => {
  const originalFetch = globalThis.fetch;
  let sentQuery = "";

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    sentQuery = String(body.query ?? "");
    return new Response(
      JSON.stringify({ num_hits: 0, hits: [], aggregations: { by_source: { buckets: [] } } }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    await getDocumentCoverage(12);

    assert(
      sentQuery.includes("document_month:"),
      `the query must narrow to the window, got ${sentQuery}`,
    );
    // Twelve months asked for, twelve named. Without this the aggregation
    // ranges over the whole history and silently returns the wrong ones.
    const named = [...sentQuery.matchAll(/document_month:"(\d{4}-\d{2})"/g)].map((m) => m[1]);
    assert(named.length === 12, `expected 12 months named, got ${named.length}`);
    assert(new Set(named).size === 12, "the months should be distinct");
    assert(
      sentQuery.includes("entity_type:Document"),
      `coverage counts documents, got ${sentQuery}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a longer window names more months, not the same ones", async () => {
  const originalFetch = globalThis.fetch;
  const asked: number[] = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    asked.push([...String(body.query ?? "").matchAll(/document_month:"/g)].length);
    // The sub-aggregation may never be asked for fewer buckets than there are
    // months on screen, or the truncation comes straight back.
    const size = body.aggs?.by_source?.aggs?.by_month?.terms?.size;
    assert(
      size >= [...String(body.query ?? "").matchAll(/document_month:"/g)].length,
      `sub-aggregation size ${size} is smaller than the window`,
    );
    return new Response(
      JSON.stringify({ num_hits: 0, hits: [], aggregations: { by_source: { buckets: [] } } }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    await getDocumentCoverage(12);
    await getDocumentCoverage(60);
    assert(asked[0] === 12 && asked[1] === 60, `expected 12 then 60, got ${asked.join(", ")}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
