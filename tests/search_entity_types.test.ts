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
