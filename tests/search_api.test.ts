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
    assert(body.max_hits === 72, "search should still over-fetch before deduping");

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
    assert(body.max_hits === 144, "search should still increase over-fetch for deeper pages");

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
