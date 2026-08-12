import { __test__ } from "../web/search_api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const build = __test__.buildQuickwitQuery;

/** Ordinary punctuation used to return HTTP 500 (#197).
 *
 * Each token was wrapped in quotes, which reads like escaping but makes a
 * phrase query. A single word survived that; anything the tokenizer split —
 * a time, a ratio, a case number pasted out of a document — became a
 * multi-term phrase, and `name` carries no positions, so Quickwit failed the
 * whole request with a schema error.
 *
 * The inputs below are the ones from the report, verified against the
 * production index: `"a:b"` errors, `a AND b` answers. */
const REPORTED = [
  { query: "a:b", label: "a colon, as in a time" },
  { query: "a/b", label: "a slash, as in a ratio" },
  { query: "a^b", label: "a caret" },
  { query: "a+b", label: "a plus" },
  { query: "entity_type:Meeting", label: "a field name pasted in" },
];

for (const { query, label } of REPORTED) {
  Deno.test(`a search for ${label} produces plain terms, not a phrase`, () => {
    const built = build(query, "", "", "", "");

    assert(
      !built.includes('"a:b"') && !built.includes('"a/b"'),
      `punctuation must not survive into a quoted phrase: ${built}`,
    );
    assert(
      built.includes(" AND b") || built.includes("meeting"),
      `expected the parts to be searchable on their own: ${built}`,
    );
  });
}

Deno.test("a trailing backslash cannot break out of a quoted value", () => {
  // `a\` closed nothing and escaped the quote the builder added, so the whole
  // query string became unparseable and Quickwit answered 400.
  const built = build("a\\", "", "", "", "");

  assert(!built.includes('\\"'), `no dangling escape may reach the query: ${built}`);
  assert(built.includes("a"), `the usable part of the term should survive: ${built}`);
});

Deno.test("an organization cannot inject a clause of its own", () => {
  // Unescaped, this returned meetings from other municipalities: the injected
  // OR escaped the source_key filter entirely.
  const built = build("begroting", "soest OR entity_type:Meeting", "", "", "");

  assert(
    built.includes('source_key:"soest OR entity_type:Meeting"'),
    `the whole value belongs inside one quoted term: ${built}`,
  );
  assert(
    !built.includes("source_key:soest OR"),
    `the value must not be able to close its own clause: ${built}`,
  );
});

Deno.test("a query of pure punctuation matches nothing rather than everything", () => {
  // Dropping the clause would leave only the organization filter, and the
  // caller would get every document of that source presented as matches.
  const built = build(":::", "soest", "", "", "");

  assert(built.includes("__geen_resultaat__"), `expected an impossible clause, got: ${built}`);
});

Deno.test("ordinary Dutch search terms still build the query they always did", () => {
  const built = build("begroting sportpark", "soest", "", "", "");

  assert(built.includes("(begroting AND sportpark)"), `unexpected clause: ${built}`);
  assert(built.includes('source_key:"soest"'), `unexpected source clause: ${built}`);
});

Deno.test("diacritics are letters, not punctuation", () => {
  // Stripping them would turn 'coördinatie' into 'co' AND 'rdinatie' and find
  // nothing.
  const built = build("coördinatie financiën", "", "", "", "");

  assert(built.includes("coördinatie"), `expected the word intact: ${built}`);
  assert(built.includes("financiën"), `expected the word intact: ${built}`);
});
