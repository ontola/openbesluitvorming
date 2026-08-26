/** Stable identifiers for every error the public API can return.
 *
 * The message beside the code is Dutch prose. It may be reworded, given a
 * better hint, or one day translated; a consumer that branches on it breaks
 * silently the moment that happens, and silently is the worst way for a
 * harvester to break. The code does not move.
 *
 * Suggested by a reuser on #224, whose point was exactly that: detection has
 * to keep working once the messages are no longer only Dutch.
 *
 * Adding a code is an ordinary change. Renaming or removing one is a breaking
 * change to the public contract — API.md publishes this list and
 * `tests/api_errors.test.ts` pins it, so neither can happen by accident.
 *
 * Admin endpoints (`/api/admin/*`) are deliberately not covered: they are not
 * part of the published surface and no reuser can reach them.
 */
export const API_ERROR_CODES = [
  // 400 — the request asked for something the API cannot honour.
  "unknown_entity_type",
  "unknown_organization",
  "unknown_sort",
  "invalid_date",
  "invalid_limit",
  "invalid_offset",
  "unsupported_phrase_slop",
  "invalid_page_number",
  "missing_export_source",
  "unknown_export_source",
  "invalid_export_cursor",
  // 404 — the request was well formed and the thing is not here.
  "entity_not_found",
  "pdf_not_found",
  "pdf_page_not_found",
  // 429
  "rate_limited",
  // 5xx — our side failed; the caller may retry.
  "search_failed",
  "stats_failed",
  "status_failed",
  "export_failed",
  "pdf_fetch_failed",
  "pdf_render_failed",
  "entity_content_failed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** `code` comes first so it is the first thing visible in a logged response. */
export function apiError(
  code: ApiErrorCode,
  status: number,
  error: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ code, error, ...extra }, { status });
}
