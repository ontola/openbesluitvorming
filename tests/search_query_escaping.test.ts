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

/** #198: quotes around a phrase were tokenised away.
 *
 * `"sociale huurwoningen"` matched every document holding both words anywhere,
 * so most hits were irrelevant and nothing in the response said so. Positions
 * are indexed on `name` and `content` from projection v3, so the phrase can
 * now be asked for as a phrase — measured against the live index on
 * 2026-08-16: 194.524 hits for the phrase, where the v2 index refuses it with
 * "does not have positions indexed".
 */
async function withProjection(version: string, fn: () => void | Promise<void>): Promise<void> {
  const original = Deno.env.get("WOOZI_PROJECTION_VERSION");
  Deno.env.set("WOOZI_PROJECTION_VERSION", version);
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

Deno.test("a quoted phrase is searched as a phrase", async () => {
  await withProjection("search-v3-meeting-date", () => {
    const query = build('"sociale huurwoningen"', "", "");
    assert(
      query.includes('"sociale huurwoningen"'),
      `the words should stay adjacent, got ${query}`,
    );
    assert(
      !query.includes("sociale AND huurwoningen"),
      `they should not be AND-ed back apart, got ${query}`,
    );
  });
});

Deno.test("a phrase combines with the loose words around it", async () => {
  await withProjection("search-v3-meeting-date", () => {
    const query = build('"sociale huurwoningen" begroting', "", "");
    assert(query.includes('"sociale huurwoningen"'), `phrase kept, got ${query}`);
    assert(query.includes("begroting"), `loose term kept, got ${query}`);
  });
});

Deno.test("one quoted word is a term, not a phrase", async () => {
  await withProjection("search-v3-meeting-date", () => {
    // A single word needs no positions, so it must not be dressed up as one.
    const query = build('"woningbouw"', "", "");
    assert(!query.includes('"woningbouw"'), `should be a bare term, got ${query}`);
    assert(query.includes("woningbouw"), `the word should survive, got ${query}`);
  });
});

Deno.test("without positions in the index the quotes are dropped, not obeyed", async () => {
  await withProjection("search-v2-pages", () => {
    // v2 refuses a phrase outright rather than degrading it, so asking for one
    // there would 500. The words are searched loose instead.
    const query = build('"sociale huurwoningen"', "", "");
    assert(
      !query.includes('"sociale huurwoningen"'),
      `a v2 index cannot answer a phrase, got ${query}`,
    );
    assert(query.includes("sociale") && query.includes("huurwoningen"), `got ${query}`);
  });
});

Deno.test("an unbalanced quote still searches", async () => {
  await withProjection("search-v3-meeting-date", () => {
    const query = build('"sociale huurwoningen', "", "");
    assert(query.includes("sociale") && query.includes("huurwoningen"), `got ${query}`);
  });
});
