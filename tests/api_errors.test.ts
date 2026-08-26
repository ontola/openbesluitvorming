import { assertEquals } from "jsr:@std/assert";
import { API_ERROR_CODES, apiError } from "../web/api_errors.ts";
import { validateSearchParams } from "../web/search_params.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function refusal(queryString: string): Promise<{ status: number; code: string }> {
  const response = validateSearchParams(new URL(`http://test/api/search?${queryString}`));
  assert(response, `expected ${queryString} to be refused`);
  const payload = await response.json();
  return { status: response.status, code: payload.code };
}

/** A reuser asked for this on #224: the message is prose and may be reworded or
 * translated, so a consumer that matches on it breaks silently. The code is the
 * part that holds still, which only works if it actually holds still. */
Deno.test("the published set of error codes is stable", () => {
  assertEquals(
    [...API_ERROR_CODES].sort(),
    [
      "entity_content_failed",
      "entity_not_found",
      "export_failed",
      "invalid_date",
      "invalid_export_cursor",
      "invalid_limit",
      "invalid_offset",
      "invalid_page_number",
      "missing_export_source",
      "pdf_fetch_failed",
      "pdf_not_found",
      "pdf_page_not_found",
      "pdf_render_failed",
      "rate_limited",
      "search_failed",
      "stats_failed",
      "status_failed",
      "unknown_entity_type",
      "unknown_export_source",
      "unknown_organization",
      "unknown_sort",
      "unsupported_phrase_slop",
    ],
    "renaming or removing a code breaks every consumer that matches on it",
  );
  assertEquals(new Set(API_ERROR_CODES).size, API_ERROR_CODES.length, "codes are unique");
});

/** A code a consumer cannot look up is only half a contract. */
Deno.test("every code is documented in API.md", async () => {
  const reference = await Deno.readTextFile(new URL("../API.md", import.meta.url));
  const undocumented = API_ERROR_CODES.filter((code) => !reference.includes(`\`${code}\``));
  assertEquals(undocumented, [], "these codes are not in the API reference");
});

Deno.test("each refusal carries the code that names it", async () => {
  assertEquals((await refusal("entityType=MEETINGS")).code, "unknown_entity_type");
  assertEquals((await refusal("organization=bestaatniet999")).code, "unknown_organization");
  assertEquals((await refusal("sort=bogus")).code, "unknown_sort");
  assertEquals((await refusal("dateFrom=bogus")).code, "invalid_date");
  assertEquals((await refusal("dateTo=2026-02-31")).code, "invalid_date");
  assertEquals((await refusal("limit=0")).code, "invalid_limit");
  assertEquals((await refusal("limit=abc")).code, "invalid_limit");
  assertEquals((await refusal("offset=-1")).code, "invalid_offset");
  assertEquals((await refusal("offset=abc")).code, "invalid_offset");
  assertEquals((await refusal('query="a b"~10')).code, "unsupported_phrase_slop");
});

Deno.test("a refusal keeps its status, message and hint alongside the code", async () => {
  const response = validateSearchParams(new URL("http://test/api/search?dateFrom=bogus"));
  assert(response, "expected a refusal");
  assertEquals(response.status, 400);

  const payload = await response.json();
  assertEquals(payload.code, "invalid_date");
  assert(payload.error.includes("JJJJ-MM-DD"), `message lost: ${payload.error}`);
  assert(payload.hint, "the hint is still there for a person to read");
});

Deno.test("extra fields survive alongside the code", async () => {
  const response = apiError("search_failed", 500, "Zoeken mislukt.", { request_id: "3f9c1a2b" });
  assertEquals(response.status, 500);

  const payload = await response.json();
  assertEquals(payload, {
    code: "search_failed",
    error: "Zoeken mislukt.",
    request_id: "3f9c1a2b",
  });
});
