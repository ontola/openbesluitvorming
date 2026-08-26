import { __test__ } from "../web/search_api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const build = __test__.buildQuickwitQuery;

/** Every entity type the projection emits and a user can search for.
 *
 * This list is the guard: a type that is absent from buildQuickwitQuery does
 * not merely become unfilterable, it falls through to the union branch and is
 * invisible in ordinary search too. Motions shipped that way — indexed and
 * findable from the meeting view, but absent from /api/search. */
const SEARCHABLE_TYPES = ["Meeting", "Document", "Motion", "Recording"];

/** Types that only carry text, so listing them without a query would return
 * rows by date and tell the reader nothing. They join the union as soon as
 * there is something to match. */
const QUERY_ONLY_TYPES = ["Recording"];

Deno.test("each searchable type filters to itself", () => {
  for (const type of SEARCHABLE_TYPES) {
    const q = build("", "", type);
    assert(q.includes(`entity_type:${type}`), `${type} must be selectable`);
    for (const other of SEARCHABLE_TYPES) {
      if (other === type || (type === "Document" && other === "Meeting")) continue;
      assert(
        !q.includes(`entity_type:${other}`),
        `filtering on ${type} must not also match ${other}: ${q}`,
      );
    }
  }
});

Deno.test("the unfiltered search covers every searchable type", () => {
  for (const query of ["", "begroting"]) {
    const q = build(query, "", "");
    for (const type of SEARCHABLE_TYPES) {
      if (!query && QUERY_ONLY_TYPES.includes(type)) {
        assert(
          !q.includes(`entity_type:${type}`),
          `${type} has nothing to offer a query-less listing: ${q}`,
        );
        continue;
      }
      assert(
        q.includes(`entity_type:${type}`),
        `unfiltered search (query=${query || "empty"}) must include ${type}: ${q}`,
      );
    }
  }
});

Deno.test("a transcript match opens the meeting it belongs to", () => {
  // The recording is what matched, but the meeting is what a reader wants:
  // that page holds the player and the spoken text. Same reasoning as a
  // DocumentPage hit resolving to its document.
  const hit = {
    entity_type: "Recording",
    entity_id: "recording:notubiz:gemeente:nunspeet:392881",
    parent_entity_id: "meeting:notubiz:gemeente:nunspeet:1412355",
  };

  assertEquals(
    __test__.searchResultEntityId(hit),
    "meeting:notubiz:gemeente:nunspeet:1412355",
    "a recording hit resolves to its meeting",
  );
  assertEquals(__test__.searchResultEntityType(hit), "Meeting", "and is presented as a meeting");
});

Deno.test("the spoken sentence wins over the agenda when both match", () => {
  // Both collapse onto the same meeting. The transcript hit is the one that
  // explains why the meeting surfaced, so it has to supply the summary even
  // though the meeting was committed a moment later.
  const meeting = {
    hit: { entity_type: "Meeting", entity_id: "meeting:x", time: "2026-04-02T10:00:01Z" },
    snippet: undefined,
  };
  const recording = {
    hit: {
      entity_type: "Recording",
      entity_id: "recording:x",
      parent_entity_id: "meeting:x",
      time: "2026-04-02T10:00:00Z",
    },
    snippet: { content: ["…het <b>ambtsgebed</b> uitspreken…"] },
  };

  assert(
    __test__.preferIndexedHit(meeting, recording),
    "the matching transcript replaces the non-matching meeting",
  );
  assert(!__test__.preferIndexedHit(recording, meeting), "and is not replaced back by it");
});

Deno.test("an unknown type falls back to the union rather than matching nothing", () => {
  const q = build("", "", "Committee");
  assert(q.includes("entity_type:Meeting"), "falls back to the union");
  // Documenting the trap: this is why a missing type is invisible rather than
  // loudly broken.
  assert(!q.includes("entity_type:Committee"), "unknown type is not queried for");
});

Deno.test("date filtering applies to every searchable type", () => {
  // start_date is projected for all three types and mapped as a datetime fast
  // field, so the range applies uniformly. The old document_month enumeration
  // only worked for Documents and had to exempt the rest, which made meetings
  // and motions vanish from any date-filtered search.
  //
  // Under v3 only: the v2 index maps start_date as a string, where the clause
  // is not merely useless but fatal. See the pushdown guard test below.
  const original = Deno.env.get("WOOZI_PROJECTION_VERSION");
  Deno.env.set("WOOZI_PROJECTION_VERSION", "search-v3-meeting-date");
  try {
    for (const type of [...SEARCHABLE_TYPES, ""]) {
      const q = build("", "", type, "2026-01-01", "2026-06-30");
      assert(
        q.includes("start_date:[2026-01-01T00:00:00Z TO 2026-06-30T23:59:59Z]"),
        `${type || "unfiltered"} must push the date filter down: ${q}`,
      );
    }

    assert(
      !build("", "", "", "", "").includes("start_date:"),
      "an unbounded search must not carry a date clause",
    );
  } finally {
    if (original === undefined) {
      Deno.env.delete("WOOZI_PROJECTION_VERSION");
    } else {
      Deno.env.set("WOOZI_PROJECTION_VERSION", original);
    }
  }
});

Deno.test("the projection version always scopes the query", () => {
  for (const type of [...SEARCHABLE_TYPES, ""]) {
    assert(
      build("", "", type).includes("projection_version:"),
      `${type || "unfiltered"} must stay scoped to the current projection`,
    );
  }
});

Deno.test("motions get a Dutch label", () => {
  assertEquals(__test__.entityTypeLabel("Motion"), "Motie", "Motion label");
  assertEquals(__test__.entityTypeLabel("Recording"), "Opname", "Recording label");
  assertEquals(__test__.entityTypeLabel("Meeting"), "Vergadering", "Meeting label unchanged");
  assertEquals(__test__.entityTypeLabel("Document"), "Document", "Document label unchanged");
});

Deno.test("date sorting is only pushed down when the index maps the field", () => {
  // Regression guard for the 2026-08-08 outage. `start_date` exists in a v2
  // index as a dynamic *string*, and Quickwit 0.8.1 does not ignore a sort on
  // it — it fails every query with "Unsupported sort field type `Str`".
  // Deploying the v3 code against the v2 index took search down completely.
  const original = Deno.env.get("WOOZI_PROJECTION_VERSION");
  try {
    Deno.env.delete("WOOZI_PROJECTION_VERSION");
    assertEquals(
      __test__.quickwitSortBy("date_desc"),
      undefined,
      "the v2 default must not ask Quickwit to sort on an unmapped field",
    );
    assertEquals(
      __test__.startDateRangeClause("2026-01-01", "2026-06-30"),
      null,
      "and must not range on it either",
    );

    Deno.env.set("WOOZI_PROJECTION_VERSION", "search-v3-meeting-date");
    assertEquals(__test__.quickwitSortBy("date_desc"), "start_date", "v3 sorts descending");
    assertEquals(__test__.quickwitSortBy("date_asc"), "-start_date", "v3 sorts ascending");
    assertEquals(
      __test__.quickwitSortBy("relevance"),
      undefined,
      "relevance is Quickwit's own score order, which is what no sort_by means",
    );
    assert(
      __test__.startDateRangeClause("2026-01-01", "2026-06-30")?.startsWith("start_date:["),
      "and pushes the range down",
    );
  } finally {
    if (original === undefined) {
      Deno.env.delete("WOOZI_PROJECTION_VERSION");
    } else {
      Deno.env.set("WOOZI_PROJECTION_VERSION", original);
    }
  }
});

/** `relevance` was in the API reference from the start and implemented by
 * nothing: it fell through to the date ordering, so a caller who asked for the
 * best match was answered with the newest and nothing said so (#223). */
Deno.test("relevance keeps the order the index scored, on either projection", () => {
  const original = Deno.env.get("WOOZI_PROJECTION_VERSION");
  try {
    // Score needs no fast field, so it is the one sort that survives a v2 index.
    Deno.env.delete("WOOZI_PROJECTION_VERSION");
    assertEquals(__test__.quickwitSortBy("relevance"), undefined, "no sort_by on v2 either");
  } finally {
    if (original === undefined) {
      Deno.env.delete("WOOZI_PROJECTION_VERSION");
    } else {
      Deno.env.set("WOOZI_PROJECTION_VERSION", original);
    }
  }

  const scored = [
    { entityId: "best", title: "b", sortDate: "2020-01-01" },
    { entityId: "next", title: "a", sortDate: "2026-01-01" },
  ] as Parameters<typeof __test__.sortResults>[0];

  assertEquals(
    __test__.sortResults(scored, "relevance").map((result) => result.entityId),
    ["best", "next"],
    "the ranking Quickwit returned is not re-sorted by date or title",
  );
  assertEquals(
    __test__.sortResults(scored, "date_desc").map((result) => result.entityId),
    ["next", "best"],
    "the other orders are unaffected",
  );
});
