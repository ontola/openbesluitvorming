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
const SEARCHABLE_TYPES = ["Meeting", "Document", "Motion"];

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
      assert(
        q.includes(`entity_type:${type}`),
        `unfiltered search (query=${query || "empty"}) must include ${type}: ${q}`,
      );
    }
  }
});

Deno.test("an unknown type falls back to the union rather than matching nothing", () => {
  const q = build("", "", "Committee");
  assert(q.includes("entity_type:Meeting"), "falls back to the union");
  // Documenting the trap: this is why a missing type is invisible rather than
  // loudly broken.
  assert(!q.includes("entity_type:Committee"), "unknown type is not queried for");
});

Deno.test("date filtering is skipped for types that carry no document_month", () => {
  // document_month is only projected for Documents. Pushing it down for a type
  // that lacks it excludes every hit of that type.
  for (const type of ["Meeting", "Motion"]) {
    const q = build("", "", type, "2026-01-01", "2026-06-30");
    assert(!q.includes("document_month"), `${type} must not be date-pushed-down: ${q}`);
  }

  const documents = build("", "", "Document", "2026-01-01", "2026-06-30");
  assert(documents.includes("document_month"), "documents still push the date filter down");
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
  assertEquals(__test__.entityTypeLabel("Meeting"), "Vergadering", "Meeting label unchanged");
  assertEquals(__test__.entityTypeLabel("Document"), "Document", "Document label unchanged");
});
