import { getEntityContent, searchMeetings } from "../web/search_api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("searchMeetings dedupes to the latest hit and keeps the newest snippet", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/v1/woozi-events/search")) {
      throw new Error(`Unexpected URL ${url}`);
    }

    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    assert(body.max_hits === 25, "search should fetch one bounded first-page window");
    assert(body.count_all === false, "public search should skip full Quickwit hit counting");

    return new Response(
      JSON.stringify({
        num_hits: 3,
        hits: [
          {
            time: "2026-03-31T10:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42",
            entity_type: "Document",
            name: "Grondprijsbrief 2025",
            start_date: "2025-01-14T17:00:00Z",
            source_key: "haarlem",
            content: "Oudere versie zonder voorkeursnippet.",
          },
          {
            time: "2026-03-31T11:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42",
            entity_type: "Document",
            name: "Grondprijsbrief 2025",
            start_date: "2025-01-14T17:00:00Z",
            source_key: "haarlem",
            content: "Nieuwere versie met sterkere inhoud.",
            payload: {
              original_url: "https://example.test/original.pdf",
            },
          },
          {
            time: "2026-03-31T09:00:00Z",
            entity_id: "meeting:notubiz:gemeente:haarlem:7",
            entity_type: "Meeting",
            name: "Raadsvergadering",
            start_date: "2025-01-10T17:00:00Z",
            source_key: "haarlem",
            content: "Agenda en besluiten.",
          },
        ],
        snippets: [
          { content: ["oudere <b>raad</b> snippet"] },
          { content: ["nieuwste <b>raad</b> snippet"] },
          { content: ["meeting <b>raad</b> snippet"] },
        ],
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const response = await searchMeetings({ query: "raad", organization: "haarlem" });
    const results = response.results;

    assert(results.length === 2, "duplicate entity ids should collapse to one result");
    assert(response.totalCount === 3, "quickwit total should be forwarded for UI estimates");
    assert(response.totalIsApproximate === true, "forwarded total should be marked approximate");
    assert(
      results[0].entityId === "document:notubiz:gemeente:haarlem:42",
      "newest document hit should be kept after dedupe",
    );
    assert(
      results[0].summaryHtml?.includes("nieuwste <b>raad</b> snippet"),
      "deduped result should keep the newest snippet, not the older one",
    );
    assert(
      results[0].downloadUrl === "https://example.test/original.pdf",
      "deduped result should keep the newest payload metadata",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings groups page hits back to one document result with matched page", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    assert(
      String(body.query).includes("DocumentPage"),
      "document queries with text should include page chunk records",
    );

    return new Response(
      JSON.stringify({
        num_hits: 2,
        hits: [
          {
            time: "2026-03-31T11:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42#page=84",
            parent_entity_id: "document:notubiz:gemeente:haarlem:42",
            page_number: 84,
            entity_type: "DocumentPage",
            name: "Grondprijsbrief 2025",
            start_date: "2025-01-14T17:00:00Z",
            source_key: "haarlem",
            content: "Pagina 84 inhoud",
            payload: {
              original_url: "https://example.test/original.pdf",
            },
          },
          {
            time: "2026-03-31T11:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42#page=85",
            parent_entity_id: "document:notubiz:gemeente:haarlem:42",
            page_number: 85,
            entity_type: "DocumentPage",
            name: "Grondprijsbrief 2025",
            start_date: "2025-01-14T17:00:00Z",
            source_key: "haarlem",
            content: "Pagina 85 inhoud",
          },
        ],
        snippets: [
          { content: ["beste <b>raad</b> snippet"] },
          { content: ["zwakkere <b>raad</b> snippet"] },
        ],
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const response = await searchMeetings({ query: "raad", entityType: "Document" });
    assert(
      response.results.length === 1,
      "page hits for the same document should group to one result",
    );
    assert(
      response.results[0].entityId === "document:notubiz:gemeente:haarlem:42",
      "grouped result should point at the parent document id",
    );
    assert(
      response.results[0].matchedPage === 84,
      "best matching page should be preserved for viewer navigation",
    );
    assert(
      response.results[0].summaryHtml?.includes("beste <b>raad</b> snippet"),
      "grouped result should keep the best snippet from the chosen page hit",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings strips markdown syntax from result snippets", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        num_hits: 1,
        hits: [
          {
            time: "2026-03-31T10:00:00Z",
            entity_id: "document:notubiz:gemeente:westervoort:42",
            entity_type: "Document",
            name: "Bijlage",
            start_date: "2026-06-22T17:00:00Z",
            source_key: "westervoort",
            content: "**Algemene regels** en **anti** worteldoek",
          },
        ],
        snippets: [
          {
            content: ["**Algemene regels** **85** Artikel 12 **<b>anti</b>** worteldoek `code`"],
          },
        ],
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );

  try {
    const response = await searchMeetings({ query: "anti" });
    assert(
      response.results[0].summaryHtml ===
        "Algemene regels 85 Artikel 12 <b>anti</b> worteldoek code",
      "snippet preview should strip markdown markers while preserving highlights",
    );
    assert(
      response.results[0].summary === "Algemene regels 85 Artikel 12 anti worteldoek code",
      "plain summary should also be free of markdown markers",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings avoids phrase queries for multi-word input", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    const query = String(body.query ?? "");
    assert(
      query.includes('"test" AND "query"'),
      "multi-word queries should be split into token clauses",
    );
    assert(
      !query.includes('"test query"'),
      "multi-word queries should not be sent as a phrase query",
    );

    return new Response(
      JSON.stringify({
        num_hits: 0,
        hits: [],
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    await searchMeetings({ query: "test query" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings supports offset paging and signals more results approximately", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    assert(body.max_hits === 49, "search should fetch enough hits to cover the requested page");

    const hits = Array.from({ length: 30 }, (_, index) => ({
      time: `2026-03-31T${String(index).padStart(2, "0")}:00:00Z`,
      entity_id: `meeting:notubiz:gemeente:haarlem:${index}`,
      entity_type: "Meeting",
      name: `Vergadering ${index}`,
      start_date: `2025-01-${String((index % 28) + 1).padStart(2, "0")}T17:00:00Z`,
      source_key: "haarlem",
      content: `Agenda ${index}`,
    }));

    return new Response(
      JSON.stringify({
        num_hits: 30,
        hits,
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const response = await searchMeetings({
      query: "vergadering",
      organization: "haarlem",
      offset: 24,
      limit: 24,
    });

    assert(response.results.length === 6, "second page should contain remaining results");
    assert(response.hasMore === false, "paging should stop when the fetched page is exhausted");
    assert(response.totalCount === 30, "total count should be forwarded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings does not advertise more pages for empty grouped windows", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    const maxHits = Number(body.max_hits ?? 0);

    const hits = Array.from({ length: maxHits }, (_, index) => ({
      time: `2026-03-31T${String(index % 24).padStart(2, "0")}:00:00Z`,
      entity_id: "document:notubiz:gemeente:haarlem:duplicate",
      entity_type: "Document",
      name: `Duplicate document ${index}`,
      start_date: "2025-01-14T17:00:00Z",
      source_key: "haarlem",
      content: `Duplicate content ${index}`,
    }));

    return new Response(
      JSON.stringify({
        num_hits: 10_000,
        hits,
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const response = await searchMeetings({
      query: "honden",
      offset: 24,
      limit: 24,
    });

    assert(response.results.length === 0, "grouped offset window should be empty");
    assert(response.hasMore === false, "empty grouped windows should stop pagination");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings avoids follow-up first-page batches after grouping", async () => {
  const originalFetch = globalThis.fetch;
  const maxHitsByRequest: number[] = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    maxHitsByRequest.push(Number(body.max_hits));

    const startOffset = Number(body.start_offset ?? 0);
    const hits =
      startOffset === 0
        ? Array.from({ length: 72 }, (_, index) => ({
            time: `2026-03-31T${String(index % 24).padStart(2, "0")}:00:00Z`,
            entity_id: "meeting:notubiz:gemeente:haarlem:duplicate",
            entity_type: "Meeting",
            name: `Vergadering duplicate ${index}`,
            start_date: "2025-01-14T17:00:00Z",
            source_key: "haarlem",
            content: `Agenda duplicate ${index}`,
          }))
        : [];

    return new Response(
      JSON.stringify({
        num_hits: 144,
        hits,
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    await searchMeetings({
      query: "vergadering",
      organization: "haarlem",
      offset: 0,
      limit: 24,
    });

    assert(maxHitsByRequest.length === 1, "grouped first page should not fetch follow-up batches");
    assert(maxHitsByRequest[0] === 25, "initial first-page batch should fetch one page window");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings caps broad document scans after grouping", async () => {
  const originalFetch = globalThis.fetch;
  const startOffsets: number[] = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    const startOffset = Number(body.start_offset ?? 0);
    const maxHits = Number(body.max_hits ?? 0);
    startOffsets.push(startOffset);

    const hits = Array.from({ length: maxHits }, (_, index) => ({
      time: `2026-03-31T${String(index % 24).padStart(2, "0")}:00:00Z`,
      entity_id: "document:notubiz:gemeente:haarlem:duplicate",
      entity_type: "Document",
      name: `Document duplicate ${startOffset + index}`,
      start_date: "2025-01-14T17:00:00Z",
      source_key: "haarlem",
      content: `Document duplicate ${startOffset + index}`,
    }));

    return new Response(
      JSON.stringify({
        num_hits: 10_000,
        hits,
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const response = await searchMeetings({
      organization: "haarlem",
      entityType: "Document",
      offset: 0,
      limit: 24,
    });

    assert(response.results.length === 1, "duplicate documents should still collapse");
    assert(response.hasMore === true, "capped broad scans should still advertise more results");
    assert(
      startOffsets.every((offset) => offset < 49),
      "broad document scans should not continue into deep Quickwit offsets",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings does not scan Quickwit for type-only filters", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;

  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("Quickwit should not be queried for type-only searches");
  };

  try {
    const response = await searchMeetings({
      entityType: "Document",
      offset: 0,
      limit: 24,
    });

    assert(fetched === false, "type-only searches should return without a Quickwit request");
    assert(response.results.length === 0, "type-only searches should return no results");
    assert(response.hasMore === false, "type-only searches should not advertise more results");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("searchMeetings uses cheaper search settings for short queries", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    assert(body.max_hits === 48, "two-character queries should not over-fetch as aggressively");
    assert(
      body.snippet_fields === undefined,
      "short queries should skip snippet generation to reduce search cost",
    );

    return new Response(
      JSON.stringify({
        num_hits: 0,
        hits: [],
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    await searchMeetings({ query: "de" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getEntityContent prefers stored markdown from the newest hit", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/v1/woozi-events/search")) {
      throw new Error(`Unexpected URL ${url}`);
    }

    return new Response(
      JSON.stringify({
        num_hits: 2,
        hits: [
          {
            time: "2026-03-31T10:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42",
            entity_type: "Document",
            payload: {
              md_text: ["oude markdown"],
            },
          },
          {
            time: "2026-03-31T11:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42",
            entity_type: "Document",
            payload: {
              md_text: ["## Nieuwe markdown"],
              original_url: "https://example.test/original.pdf",
            },
          },
        ],
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const content = await getEntityContent("document:notubiz:gemeente:haarlem:42");

    assert(content?.markdownText === "## Nieuwe markdown", "newest hit should win");
    assert(
      content?.downloadUrl === "https://example.test/original.pdf",
      "detail view should use newest payload metadata",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("documentMonthTerms enumerates months and rejects unusable ranges", async () => {
  const { documentMonthTerms } = await import("../web/search_api.ts");

  assert(
    JSON.stringify(documentMonthTerms("2024-01-15", "2024-03-02")) ===
      JSON.stringify(["2024-01", "2024-02", "2024-03"]),
    "range should cover the months of both bounds inclusive",
  );
  assert(
    documentMonthTerms("2024-05-01", "2024-05-31")?.length === 1,
    "single-month range yields one term",
  );

  const openEnded = documentMonthTerms("2026-01-01", "");
  assert(openEnded !== null && openEnded[0] === "2026-01", "open-ended 'to' still pushes down");

  assert(documentMonthTerms("2002-01-01", "2021-12-31") === null, "multi-decade range stays app-side");
  assert(documentMonthTerms("2024-06-01", "2024-01-01") === null, "inverted range is rejected");
  assert(documentMonthTerms("geen-datum", "2024-01-01") === null, "garbage input is rejected");
});
