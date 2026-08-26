import { validateSearchParams } from "../web/search_params.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const validate = validateSearchParams;

function check(queryString: string): { status: number; body: Record<string, string> } | null {
  const response = validate(new URL(`http://test/api/search?${queryString}`));
  return response ? { status: response.status, body: null as never } : null;
}

async function body(queryString: string): Promise<Record<string, string>> {
  const response = validate(new URL(`http://test/api/search?${queryString}`));
  assert(response, `expected ${queryString} to be rejected`);
  return await response.json();
}

/** A filter the API cannot honour must be refused, not dropped.
 *
 * `entityType=MEETINGS` used to return HTTP 200 with the *unfiltered* set --
 * so a caller asking for meetings received documents, which is the opposite of
 * what they asked for, and nothing in the response said so (#196). */
Deno.test("an unknown entityType is refused rather than ignored", async () => {
  const rejected = check("entityType=MEETINGS");
  assert(rejected?.status === 400, "expected HTTP 400");

  const payload = await body("entityType=MEETINGS");
  assert(
    payload.hint?.includes("Meeting"),
    `the caller should be told what is valid: ${JSON.stringify(payload)}`,
  );
});

Deno.test("the documented entity types are all accepted", () => {
  for (const entityType of ["Meeting", "Document", "Motion", "Recording"]) {
    assert(check(`entityType=${entityType}`) === null, `${entityType} should be accepted`);
  }
  assert(check("") === null, "no filter at all is fine");
});

Deno.test("an unknown organization is refused, and points at /api/sources", async () => {
  assert(check("organization=bestaatniet999")?.status === 400, "expected HTTP 400");

  const payload = await body("organization=Soest");
  assert(
    payload.hint?.includes("/api/sources"),
    `the caller should be told where to look: ${JSON.stringify(payload)}`,
  );
});

/** A source can stop being imported and keep years of searchable data.
 *
 * Validating against getSource would reject Dongen, which is withdrawn from
 * importing but still answers searches with real documents. /api/sources is
 * the list the API itself publishes, so it is the list to check against. */
Deno.test("a withdrawn but still indexed source stays searchable", () => {
  assert(check("organization=dongen") === null, "dongen is listed by /api/sources");
  assert(check("organization=soest") === null, "soest is an ordinary active source");
});

Deno.test("a limit below one is refused instead of quietly becoming one", async () => {
  assert(check("limit=0")?.status === 400, "limit=0 should be rejected");
  assert(check("limit=-5")?.status === 400, "a negative limit should be rejected");

  const payload = await body("limit=0");
  assert(payload.error.includes("minstens 1"), `unhelpful message: ${payload.error}`);
});

Deno.test("a non-integer limit or offset is refused", () => {
  assert(check("limit=abc")?.status === 400, "a non-numeric limit should be rejected");
  assert(check("limit=2.5")?.status === 400, "a fractional limit should be rejected");
  assert(check("offset=-1")?.status === 400, "a negative offset should be rejected");
});

Deno.test("ordinary paging parameters pass untouched", () => {
  assert(check("query=begroting&organization=soest&limit=24&offset=0") === null, "the common case");
  assert(check("limit=100&offset=200") === null, "deep paging is not itself invalid");
  assert(check("limit=&offset=") === null, "empty values fall back to the defaults");
});

/** `sort=bogus` used to answer HTTP 200 in a perfectly ordinary order, which is
 * the same silent substitution `entityType` made before #196 (#223). */
Deno.test("an unknown sort is refused rather than silently becoming date_desc", async () => {
  assert(check("sort=bogus")?.status === 400, "expected HTTP 400");

  const payload = await body("sort=bogus");
  assert(
    payload.hint?.includes("date_desc"),
    `the caller should be told what is valid: ${JSON.stringify(payload)}`,
  );
});

Deno.test("every implemented sort order is accepted", () => {
  for (const sort of ["date_desc", "date_asc", "title_asc", "relevance"]) {
    assert(check(`sort=${sort}`) === null, `${sort} should be accepted`);
  }
  assert(check("sort=") === null, "no sort at all falls back to the default");
});

/** The dangerous one. An unreadable date filtered every result away, so it read
 * as "nothing was decided in that period" rather than "that date is not a
 * date" -- and nothing in the response could tell the two apart (#223). */
Deno.test("an unreadable date is refused instead of quietly emptying the result", async () => {
  assert(check("dateFrom=bogus")?.status === 400, "dateFrom=bogus should be rejected");
  assert(check("dateTo=bogus")?.status === 400, "dateTo=bogus should be rejected");
  assert(check("dateFrom=2026-02-31")?.status === 400, "31 February is not a day");
  assert(check("dateFrom=14-08-2026")?.status === 400, "the Dutch notation is not ISO");
  assert(check("dateFrom=2026-08-14T00:00:00Z")?.status === 400, "a time on the end is refused");

  const payload = await body("dateFrom=bogus");
  assert(payload.error.includes("JJJJ-MM-DD"), `unhelpful message: ${payload.error}`);
});

Deno.test("ordinary date ranges pass untouched", () => {
  assert(check("dateFrom=2026-01-01&dateTo=2026-12-31") === null, "a whole year");
  assert(check("dateFrom=2024-02-29") === null, "a leap day is a day");
  assert(check("dateFrom=&dateTo=") === null, "empty values are no filter at all");
});

/** A slop can only widen a phrase, so a caller who writes one expects at least
 * the bare phrase's hits. The `~10` fell through to the loose terms and was
 * ANDed on as the word "10", which halved the result instead (#224). */
Deno.test("proximity notation is refused rather than searched as a number", async () => {
  assert(check('query="sociale huurwoningen"~10')?.status === 400, "expected HTTP 400");
  assert(check('query="a b"~5 begroting')?.status === 400, "also alongside other words");

  const payload = await body('query="sociale huurwoningen"~10');
  assert(payload.hint?.includes("frase"), `unhelpful hint: ${JSON.stringify(payload)}`);
});

Deno.test("ordinary phrase and term queries are not mistaken for a slop", () => {
  assert(check('query="sociale huurwoningen"') === null, "a bare phrase is supported");
  assert(check("query=begroting 2026") === null, "a number is an ordinary word");
  assert(check('query="woningen" ~ 10') === null, "a stray tilde is not the notation");
  assert(check("query=~10") === null, "a tilde outside a phrase is punctuation");
});
