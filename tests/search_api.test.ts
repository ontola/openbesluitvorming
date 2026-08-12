import { getEntityContent, searchMeetings } from "../web/search_api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Run a test against the v3 projection.
 *
 * The date pushdown is mapping-dependent: v2 stores start_date as a dynamic
 * string, where Quickwit rejects both the sort and the range instead of
 * ignoring them (the 2026-08-08 search outage). These tests describe v3
 * behaviour, so they have to say so.
 */
async function withV3Projection(fn: () => Promise<void> | void): Promise<void> {
  const original = Deno.env.get("WOOZI_PROJECTION_VERSION");
  Deno.env.set("WOOZI_PROJECTION_VERSION", "search-v3-meeting-date");
  try {
    await fn();
  } finally {
    if (original === undefined) {
      Deno.env.delete("WOOZI_PROJECTION_VERSION");
    } else {
      Deno.env.set("WOOZI_PROJECTION_VERSION", original);
    }
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
    // Over-fetch on purpose: several index rows collapse into one result, so
    // asking for exactly one page's worth returned a third of it (#193).
    assert(body.max_hits >= 25, "search should over-fetch to fill a page after grouping");
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
    // Three index rows, two results. totalCount used to forward Quickwit's raw
    // row count, which is why it read 9,933 for a few thousand documents and
    // moved between calls (#195). Having scanned the whole match set, the
    // count is now simply exact -- and says so.
    assert(response.totalCount === 2, "the count should describe results, not index rows");
    assert(
      response.totalIsApproximate === false,
      "a fully scanned result set gives an exact count",
    );
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
    // The tokens used to be quoted individually. That still split the words,
    // but each quoted token was its own one-term phrase, and the moment
    // punctuation split a token further it became a real phrase query against
    // a field without positions -- a 500 on input as ordinary as `14:30`
    // (#197). Bare terms carry the same meaning without that edge.
    assert(
      query.includes("(test AND query)"),
      "multi-word queries should be split into bare token clauses",
    );
    assert(
      !query.includes('"test query"') && !query.includes('"test"'),
      "no part of user input should reach the query in quotes",
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
    assert(body.max_hits >= 49, "search should fetch enough hits to cover the requested page");

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

/** A window that collapses to almost nothing must be followed by another.
 *
 * This test used to assert the opposite -- exactly one request, no follow-ups
 * -- which is precisely the behaviour that made a request for 24 results
 * return 13 and made paging past them impossible (#193). Stopping after one
 * window is cheap and wrong.
 *
 * What still has to hold is that it terminates: once the index runs out, the
 * loop stops rather than asking again forever. The stub serves slices of a
 * fixed pool the way Quickwit does, so "fewer rows than asked for" keeps its
 * real meaning of "there are no more".
 */
Deno.test("a window that groups down to one result is followed by another", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ maxHits: number; startOffset: number }> = [];
  const POOL_ROWS = 1200;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    const startOffset = Number(body.start_offset ?? 0);
    const maxHits = Number(body.max_hits);
    requests.push({ maxHits, startOffset });

    // Every row belongs to the same entity, so any window collapses to one
    // result no matter how much of it is read.
    const count = Math.max(0, Math.min(maxHits, POOL_ROWS - startOffset));
    const hits = Array.from({ length: count }, (_, index) => ({
      time: `2026-03-31T${String(index % 24).padStart(2, "0")}:00:00Z`,
      entity_id: "meeting:notubiz:gemeente:haarlem:duplicate",
      entity_type: "Meeting",
      name: "Vergadering duplicate",
      start_date: "2025-01-14T17:00:00Z",
      source_key: "haarlem",
      content: "Agenda duplicate",
    }));

    return new Response(JSON.stringify({ num_hits: POOL_ROWS, hits }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await searchMeetings({
      query: "vergadering",
      organization: "haarlem",
      offset: 0,
      limit: 24,
    });

    assert(requests.length > 1, "a collapsed window should be followed by another request");
    assert(requests.length <= 8, `the scan must terminate, made ${requests.length} requests`);
    assert(requests[1].startOffset === requests[0].maxHits, "the next request continues after it");
    assert(response.results.length === 1, "the duplicate rows are still one result");
    assert(response.hasMore === false, "with the index exhausted there is no next page");
    assert(response.totalCount === 1, "one entity is one result, whatever it costs in rows");
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

Deno.test("searchMeetings skips snippets for short queries", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
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

/** Two commits of one document arrive; the detail view must render the newer.
 *
 * This test used to put the markdown inline in the indexed payload as
 * `md_text`. That contract is gone: the search payload is compacted and the
 * text now lives in object storage under `derived_content.markdown_key`, which
 * getEntityContent reads back. The assertion that matters -- newest hit wins,
 * and its metadata is what the detail view uses -- is unchanged; only the way
 * the markdown reaches it is. The S3 read goes through globalThis.fetch, so
 * the same stub covers both hops and the test stays hermetic. */
Deno.test("getEntityContent prefers stored markdown from the newest hit", async () => {
  const originalFetch = globalThis.fetch;
  const newestKey = "documents/notubiz/gemeente/haarlem/42/newest.pdf.pymupdf-v1.md";
  const olderKey = "documents/notubiz/gemeente/haarlem/42/older.pdf.pymupdf-v1.md";

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes(newestKey)) {
      return new Response("## Nieuwe markdown");
    }
    if (url.includes(olderKey)) {
      return new Response("oude markdown");
    }
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
              derived_content: { markdown_key: olderKey },
              original_url: "https://example.test/older.pdf",
            },
          },
          {
            time: "2026-03-31T11:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42",
            entity_type: "Document",
            payload: {
              derived_content: { markdown_key: newestKey },
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

Deno.test("startDateRangeClause bounds the range on whole days", async () => {
  await withV3Projection(async () => {
    const { startDateRangeClause } = await import("../web/search_api.ts");

    assert(
      startDateRangeClause("2024-01-15", "2024-03-02") ===
        "start_date:[2024-01-15T00:00:00Z TO 2024-03-02T23:59:59Z]",
      "both bounds are inclusive, and 'to' covers the whole day",
    );
    assert(
      startDateRangeClause("2026-01-01", "") === "start_date:[2026-01-01T00:00:00Z TO *]",
      "open-ended 'to' still pushes down",
    );
    assert(
      startDateRangeClause("", "2026-01-01") === "start_date:[* TO 2026-01-01T23:59:59Z]",
      "'to' alone still pushes down",
    );
    assert(startDateRangeClause("", "") === null, "no bounds means no clause");
    assert(startDateRangeClause("geen-datum", "") === null, "garbage input is rejected");
  });
});

Deno.test("date-filtered search pushes a start_date range down for every type", async () => {
  await withV3Projection(async () => {
    // Regression guard for #184's sibling bug. The date filter used to enumerate
    // document_month terms, which only Documents carry, so meetings and motions
    // had to be exempted and never showed up in a date-filtered search at all.
    // Measured in production 2026-07-31 on dateFrom=2026-01-01: 40 of the first
    // 40 hits were meetings dated 2018-2019 and zero rows were returned, which
    // reads to a user as "nothing exists after 2020".
    const originalFetch = globalThis.fetch;
    const capturedQueries: string[] = [];

    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
      capturedQueries.push(String(body.query ?? ""));
      return new Response(JSON.stringify({ num_hits: 0, hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      for (const entityType of ["", "Meeting", "Motion", "Document"]) {
        await searchMeetings({
          query: "begroting",
          entityType,
          dateFrom: "2026-01-01",
          dateTo: "2026-03-31",
          offset: 0,
          limit: 24,
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert(
      capturedQueries.length === 4,
      `expected one query per type, got ${capturedQueries.length}`,
    );
    for (const query of capturedQueries) {
      assert(
        query.includes("start_date:[2026-01-01T00:00:00Z TO 2026-03-31T23:59:59Z]"),
        `every type must push the date range down, got: ${query}`,
      );
      assert(!query.includes("document_month"), `month enumeration is gone, got: ${query}`);
    }
  });
});

Deno.test("search asks Quickwit to order by meeting date, not ingest time", async () => {
  await withV3Projection(async () => {
    // #184. The index's timestamp_field is `time` (the ingest time), so an
    // unsorted request returns whatever was written last and the app-side sort
    // could only reorder that already-wrong window. Sorting has to be pushed
    // down for the window itself to hold the newest meetings.
    //
    // Direction is inverted in Quickwit 0.8.1: bare = descending, `-` = ascending.
    const originalFetch = globalThis.fetch;
    const captured: Array<string | undefined> = [];

    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
      captured.push(body.sort_by);
      return new Response(JSON.stringify({ num_hits: 0, hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      for (const sort of ["date_desc", "date_asc", "title_asc", ""]) {
        await searchMeetings({ query: "begroting", sort, offset: 0, limit: 24 });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert(captured[0] === "start_date", `date_desc should sort newest first, got ${captured[0]}`);
    assert(captured[1] === "-start_date", `date_asc should sort oldest first, got ${captured[1]}`);
    assert(captured[2] === undefined, "title sort has no fast field and stays app-side");
    assert(captured[3] === "start_date", `default sort is newest first, got ${captured[3]}`);
  });
});

Deno.test("a motion detail carries its outcome and inherits its attachment's file", async () => {
  // A motion entity has no content of its own: the words people came to read
  // sit in the PDF hanging off it. Without resolving that, the reader showed
  // "geen documenttekst beschikbaar" while the text was one hop away.
  //
  // markdownText itself comes from object storage, so what is asserted here is
  // the plumbing this change added — that the attachment is fetched and its
  // content fields are spread onto the motion. The markdown rides the very
  // same object.
  const originalFetch = globalThis.fetch;
  const motionId = "motion:ibabs:gemeente:culemborg:m11";
  const attachmentId = "document:ibabs:gemeente:culemborg:pdf1";
  const queried: string[] = [];

  // Quickwit takes the query in the POST body, not the URL.
  globalThis.fetch = (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    queried.push(body);
    const hit = body.includes(attachmentId)
      ? {
          time: "2026-03-31T10:00:00Z",
          entity_id: attachmentId,
          entity_type: "Document",
          name: "Motie M11",
          payload: { original_url: "https://example.test/motie-m11.pdf" },
        }
      : {
          time: "2026-03-31T10:00:00Z",
          entity_id: motionId,
          entity_type: "Motion",
          name: "7.2 Motie M11 Motie VVD CDA Pavijen Vijf Vrij",
          payload: {
            result: "verworpen",
            status: "Moties verworpen",
            tally: { in_favour: 7, against: 14 },
            votes: [{ option: "tegen", group_name: "GroenLinks", voter_name: "Jansen" }],
            attachment: [attachmentId],
            meeting: "meeting:ibabs:gemeente:culemborg:m1",
          },
        };

    return Promise.resolve(
      new Response(JSON.stringify({ num_hits: 1, hits: [hit] }), {
        headers: { "content-type": "application/json" },
      }),
    );
  };

  try {
    const content = await getEntityContent(motionId);

    assert(content?.entityType === "Motion", "the entity type survives");
    assert(content?.motion?.result === "verworpen", "the outcome is returned");
    assert(content?.motion?.votes?.length === 1, "so is the vote breakdown");
    assert(
      content?.motion?.tally?.against === 14,
      "and the tally, which is what the page leads with",
    );

    // The part that was missing: the attachment is looked up at all, and its
    // file surfaces on the motion.
    assert(
      queried.some((body) => body.includes(attachmentId)),
      "the attachment should be fetched",
    );
    assert(
      content?.downloadUrl === "https://example.test/motie-m11.pdf",
      `the attachment's file should surface, got ${content?.downloadUrl}`,
    );
    assert(content?.pdfUrl !== undefined, "so the PDF view works on a motion too");
    // The viewer renders pages by entity id, and a motion has none of its own:
    // pointing it at the motion returned 404 and showed a blank pane.
    assert(
      content?.pdfEntityId === attachmentId,
      `the PDF viewer must be pointed at the attachment, got ${content?.pdfEntityId}`,
    );
    assert(
      content?.meetingId === "meeting:ibabs:gemeente:culemborg:m1",
      "the crumb back to the meeting still resolves",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a motion that points at itself does not hang the request", async () => {
  // Resolving the attachment re-enters getEntityContent. An id that resolves
  // to something advertising an attachment would recurse forever, and the
  // first version of this did exactly that against a stub.
  const originalFetch = globalThis.fetch;
  const motionId = "motion:ibabs:gemeente:culemborg:loop";
  let calls = 0;

  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          num_hits: 1,
          hits: [
            {
              time: "2026-03-31T10:00:00Z",
              entity_id: motionId,
              entity_type: "Motion",
              name: "Motie",
              // Points at itself, and at a second motion that would point back.
              payload: { result: "aangenomen", attachment: [motionId] },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };

  try {
    const content = await getEntityContent(motionId);
    assert(content?.motion?.result === "aangenomen", "it still returns the motion");
    assert(calls <= 2, `at most one extra lookup, made ${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a meeting's motions get the download link of their own attachment", async () => {
  const originalFetch = globalThis.fetch;
  const meetingId = "meeting:ibabs:gemeente:utrecht:m1";
  const attachmentQueries: string[] = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    const query = String(body.query ?? "");

    if (query.includes("entity_type:Motion")) {
      return new Response(
        JSON.stringify({
          num_hits: 3,
          hits: [
            {
              time: "2026-01-29T10:00:00Z",
              entity_id: "motion:ibabs:gemeente:utrecht:a",
              entity_type: "Motion",
              name: "M1 Eerste",
              payload: { attachment: ["document:ibabs:gemeente:utrecht:doc-a"] },
            },
            {
              time: "2026-01-29T10:00:00Z",
              entity_id: "motion:ibabs:gemeente:utrecht:b",
              entity_type: "Motion",
              name: "M2 Tweede",
              payload: { attachment: ["document:ibabs:gemeente:utrecht:doc-b"] },
            },
            {
              time: "2026-01-29T10:00:00Z",
              entity_id: "motion:ibabs:gemeente:utrecht:c",
              entity_type: "Motion",
              name: "M3 Zonder bijlage",
              payload: {},
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    if (query.includes("doc-a") || query.includes("doc-b")) {
      attachmentQueries.push(query);
      return new Response(
        JSON.stringify({
          num_hits: 2,
          hits: [
            // Deliberately returned in the opposite order to the motions, so a
            // by-position mapping would hand each motion the other one's file.
            {
              time: "2026-01-29T10:00:00Z",
              entity_id: "document:ibabs:gemeente:utrecht:doc-b",
              entity_type: "Document",
              file_name: "tweede.docx",
              payload: { original_url: "https://example.org/tweede.docx" },
            },
            {
              time: "2026-01-29T10:00:00Z",
              entity_id: "document:ibabs:gemeente:utrecht:doc-a",
              entity_type: "Document",
              file_name: "eerste.pdf",
              payload: { original_url: "https://example.org/eerste.pdf" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        num_hits: 1,
        hits: [
          {
            time: "2026-01-29T10:00:00Z",
            entity_id: meetingId,
            entity_type: "Meeting",
            name: "Gemeenteraad",
            source_key: "utrecht",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  try {
    const content = await getEntityContent(meetingId);
    const motions = content?.motions ?? [];
    const first = motions.find((motion) => motion.id.endsWith(":a"));
    const second = motions.find((motion) => motion.id.endsWith(":b"));
    const third = motions.find((motion) => motion.id.endsWith(":c"));

    assert(first?.download_url === "https://example.org/eerste.pdf", "first keeps its own file");
    assert(second?.download_url === "https://example.org/tweede.docx", "second keeps its own file");
    assert(first?.attachment_is_pdf === true, "a .pdf attachment can be rendered as a thumbnail");
    assert(second?.attachment_is_pdf === false, "a .docx attachment cannot");
    assert(third?.download_url === undefined, "a motion without an attachment gets no link");
    assert(
      attachmentQueries.length === 1,
      `attachments resolve in one query, made ${attachmentQueries.length}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** The reported defect, in the shape it was reported (#193).
 *
 * Soest + "begroting": a request for 24 results returned 13, for 50 returned
 * 17, for 100 returned 31, and offset=20 returned an empty list while
 * totalCount still claimed 9,933. The cause was that page rows collapse into
 * their parent document *after* the scan window had been truncated, so the
 * page was assembled from whatever few documents happened to be in it.
 *
 * The ratio here is the one measured on reindexed production data: 6.7 page
 * rows per document, rounded to 7.
 */
Deno.test("a full page is delivered even when rows collapse seven to one", async () => {
  const originalFetch = globalThis.fetch;
  const DOCUMENTS = 200;
  const PAGES_PER_DOCUMENT = 7;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    const startOffset = Number(body.start_offset ?? 0);
    const maxHits = Number(body.max_hits);
    const totalRows = DOCUMENTS * PAGES_PER_DOCUMENT;
    const count = Math.max(0, Math.min(maxHits, totalRows - startOffset));

    const hits = Array.from({ length: count }, (_, index) => {
      const row = startOffset + index;
      const documentIndex = Math.floor(row / PAGES_PER_DOCUMENT);
      const pageNumber = (row % PAGES_PER_DOCUMENT) + 1;
      return {
        time: "2026-03-31T11:00:00Z",
        entity_id: `document:ibabs:gemeente:soest:${documentIndex}#page=${pageNumber}`,
        parent_entity_id: `document:ibabs:gemeente:soest:${documentIndex}`,
        page_number: pageNumber,
        entity_type: "DocumentPage",
        name: `Begroting ${documentIndex}`,
        start_date: "2025-01-14T17:00:00Z",
        source_key: "soest",
        content: `Pagina ${pageNumber} van document ${documentIndex}`,
      };
    });

    return new Response(JSON.stringify({ num_hits: totalRows, hits }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const first = await searchMeetings({ query: "begroting", organization: "soest", limit: 24 });
    assert(
      first.results.length === 24,
      `a page of 24 should hold 24 results, got ${first.results.length}`,
    );
    assert(first.hasMore === true, "there are 200 documents, so there is a next page");

    const deep = await searchMeetings({
      query: "begroting",
      organization: "soest",
      limit: 10,
      offset: 100,
    });
    assert(
      deep.results.length === 10,
      `paging deep into the set must still fill a page, got ${deep.results.length}`,
    );
    assert(
      deep.results[0].entityId === "document:ibabs:gemeente:soest:100",
      `offset should land on the 101st document, got ${deep.results[0].entityId}`,
    );

    const wide = await searchMeetings({ query: "begroting", organization: "soest", limit: 100 });
    assert(
      wide.results.length === 100,
      `limit=100 should return 100 results, got ${wide.results.length}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
