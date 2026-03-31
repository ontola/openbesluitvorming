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

    const body = JSON.parse(String(init?.body ?? "{}"));
    assert(body.max_hits === 96, "search should over-fetch before deduping");

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
    const results = await searchMeetings({ query: "raad", organization: "haarlem" });

    assert(results.length === 2, "duplicate entity ids should collapse to one result");
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
