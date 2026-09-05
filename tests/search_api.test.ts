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

/** #195: identical URLs answered with wildly different totals.
 *
 * The reported swing (4,153 / 8,358 / 9,933) came from forwarding Quickwit's
 * raw row count, and that is gone. What remained was subtler: num_hits was
 * accumulated as a running maximum across the scan's rounds. Ingestion
 * publishes splits while a search runs, so a later round can honestly report a
 * larger index than the round before it -- and the total then depended on how
 * many rounds that particular request happened to take.
 *
 * The same search is run twice here against the same rows, differing only in
 * whether the index grows underneath it. The answer has to be the same.
 */
Deno.test("a total is not inflated by rows that arrive mid-scan", async () => {
  const originalFetch = globalThis.fetch;
  const DOCUMENTS = 400;
  const PAGES_PER_DOCUMENT = 20;
  const TOTAL_ROWS = DOCUMENTS * PAGES_PER_DOCUMENT;

  const serve = (growPerRound: number) => {
    let round = 0;
    return async (_input: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
      const startOffset = Number(body.start_offset ?? 0);
      const maxHits = Number(body.max_hits);
      const count = Math.max(0, Math.min(maxHits, TOTAL_ROWS - startOffset));
      // The dedicated count request (max_hits 0, count_all) sees the index as
      // it is; the growth simulates rows arriving between scan pages.
      const numHits = body.count_all ? TOTAL_ROWS : TOTAL_ROWS + round * growPerRound;
      round += 1;

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

      return new Response(JSON.stringify({ num_hits: numHits, hits }), {
        headers: { "content-type": "application/json" },
      });
    };
  };

  const request = { query: "begroting", organization: "soest", limit: 10, offset: 60 };

  try {
    globalThis.fetch = serve(0) as typeof globalThis.fetch;
    const staticIndex = await searchMeetings({ ...request });

    globalThis.fetch = serve(5_000) as typeof globalThis.fetch;
    const growingIndex = await searchMeetings({ ...request });

    assert(
      staticIndex.totalIsApproximate && growingIndex.totalIsApproximate,
      "this scan stops at the budget, so both totals are estimates",
    );
    assert(
      staticIndex.totalCount === growingIndex.totalCount,
      `rows arriving mid-scan must not change the total, got ${staticIndex.totalCount} against ${growingIndex.totalCount}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** A meeting from a withdrawn source must still open.
 *
 * Dongen is withdrawn from importing — Notubiz reports the organisation as
 * non-active — while its 9,197 entities sit in the export log and answer
 * searches. The detail view resolved the source through the *import* gate to
 * decide whether to fetch a live agenda, so it threw "Unknown or unsupported
 * source" and answered 500 for every one of those meetings: findable in
 * search, unreadable when opened. Measured on production 2026-08-16.
 *
 * The agenda is the only part of this response that comes from the supplier
 * rather than our own storage, so it is also the only part a supplier may
 * cost. The stub answers the live agenda call with a failure to pin that.
 */
Deno.test("a meeting from a withdrawn source opens without its live agenda", async () => {
  const originalFetch = globalThis.fetch;
  const entityId = "meeting:notubiz:gemeente:dongen:1441836";

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // The supplier is unreachable for this source; the page must survive it.
    if (url.includes("notubiz")) {
      throw new Error("Notubiz is not reachable for a withdrawn organisation");
    }

    return new Response(
      JSON.stringify({
        num_hits: 1,
        hits: [
          {
            time: "2026-03-31T11:00:00Z",
            entity_id: entityId,
            entity_type: "Meeting",
            name: "Raadsvergadering",
            source_key: "dongen",
            start_date: "2025-06-10T17:30:00Z",
            payload: {},
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  try {
    const content = await getEntityContent(entityId);
    assert(content !== undefined, "a withdrawn source's meeting must still resolve");
    assert(
      content?.title === "Raadsvergadering",
      `the stored payload should still be served, got ${content?.title}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** #213: HTML entities arriving in the API as visible text.
 *
 * The extracted text already carries escaped markup — a source `<br>` reaches
 * the index as the six literal characters `&lt;br&gt;` — and the response
 * escaped that ampersand a second time, so `&amp;lt;br&amp;gt;` appeared on
 * screen and in `summary`, which is documented as plain text. Measured on
 * production 2026-08-16: five such places in one result page.
 */
Deno.test("a snippet carries the highlight and nothing else", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        num_hits: 1,
        hits: [
          {
            time: "2026-03-31T10:00:00Z",
            entity_id: "document:notubiz:gemeente:haarlem:42",
            entity_type: "Document",
            name: "Waddenbuurt",
            source_key: "haarlem",
            content: "x",
          },
        ],
        snippets: [
          {
            content: [
              "<b>Waddenbuurt</b> vast te stellen&lt;br&gt;2. Archeologie 2&#x27; dient de aanvrager",
            ],
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );

  try {
    const response = await searchMeetings({ query: "waddenbuurt" });
    const [result] = response.results;

    assert(
      !result.summary.includes("&"),
      `summary is documented as plain text, got ${JSON.stringify(result.summary)}`,
    );
    assert(
      result.summary.includes("Archeologie 2' dient"),
      `the apostrophe should be a character, got ${JSON.stringify(result.summary)}`,
    );
    assert(
      !result.summary.includes("br"),
      `source markup does not belong in a text preview, got ${JSON.stringify(result.summary)}`,
    );
    assert(
      result.summaryHtml?.includes("<b>Waddenbuurt</b>"),
      `the highlight must survive, got ${JSON.stringify(result.summaryHtml)}`,
    );
    assert(
      !/&amp;(lt|gt);/.test(result.summaryHtml ?? ""),
      `nothing should be escaped twice, got ${JSON.stringify(result.summaryHtml)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("the total does not move with the sort order", async () => {
  // #265: the same query showed 146,881, 189,609 and 339,160 results under
  // three sort orders. The numerator was a partial count and the denominator
  // a collapse ratio sampled in whatever order the sort put first.
  const originalFetch = globalThis.fetch;
  const TOTAL_ROWS = 570_855;
  const serve = async (_input: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    if (body.count_all) {
      return new Response(JSON.stringify({ num_hits: TOTAL_ROWS, hits: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    // A sorted scan sees documents with many pages first (5 rows per result);
    // relevance order collapses 2 to 1. Same index, different sample.
    const perResult = body.sort_by ? 5 : 2;
    const maxHits = Number(body.max_hits);
    const startOffset = Number(body.start_offset ?? 0);
    const hits = Array.from({ length: maxHits }, (_, index) => {
      const row = startOffset + index;
      const documentIndex = Math.floor(row / perResult);
      return {
        time: "2026-03-31T11:00:00Z",
        entity_id: `document:notubiz:gemeente:ermelo:${documentIndex}#page=${(row % perResult) + 1}`,
        parent_entity_id: `document:notubiz:gemeente:ermelo:${documentIndex}`,
        page_number: (row % perResult) + 1,
        entity_type: "DocumentPage",
        name: `Schriftelijke vragen ${documentIndex}`,
        start_date: "2025-01-14T17:00:00Z",
        source_key: "ermelo",
        content: "schriftelijke vragen over van alles",
      };
    });
    // num_hits from a scan page is deliberately partial, as Quickwit's is
    // without count_all.
    return new Response(JSON.stringify({ num_hits: 4190, hits }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    globalThis.fetch = serve as typeof globalThis.fetch;
    await withV3Projection(async () => {
      const totals: Record<string, number> = {};
      for (const sort of ["relevance", "date_desc", "date_asc", "title_asc"]) {
        const response = await searchMeetings({ query: "schriftelijke vragen", sort, limit: 24 });
        assert(response.totalIsApproximate, `${sort}: a capped scan is an estimate`);
        totals[sort] = response.totalCount ?? 0;
      }
      const distinct = new Set(Object.values(totals));
      assert(distinct.size === 1, `one estimate for every sort, got ${JSON.stringify(totals)}`);
      // 570,855 rows at 2 rows per result, rounded to three figures.
      assert(
        totals.relevance === 285_000,
        `estimate from the exact count, got ${totals.relevance}`,
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an estimate is rounded to three significant figures", async () => {
  const { roundEstimate } = await import("../web/search_api.ts");
  assert(roundEstimate(190_285) === 190_000, "190,285 -> 190,000");
  assert(roundEstimate(146_881) === 147_000, "146,881 -> 147,000");
  assert(roundEstimate(1_234) === 1_230, "1,234 -> 1,230");
  assert(roundEstimate(999) === 999, "under a thousand stays exact");
});
