/** Validation for the /api/search query string.
 *
 * Kept out of server.ts for the same reason rate_limit.ts is: importing
 * server.ts starts a listener and a scheduler, so anything that lives there is
 * only testable in production. This is pure input inspection.
 *
 * The rule these share: refuse what the API cannot honour. Every case below
 * used to be a silent HTTP 200 that did something other than what was asked
 * (#196, #199), which is harder to notice than an error and, for a consumer
 * building a report, worse than one.
 */
import { listAdminSourceOptions } from "../src/sources/index.ts";

/** The entity types /api/search accepts, exactly as documented. */
export const SEARCH_ENTITY_TYPES = ["Meeting", "Document", "Motion", "Recording"];

/** The sort orders /api/search accepts, exactly as documented.
 *
 * `relevance` was documented long before it worked: every unrecognised value,
 * that one included, fell through to the date ordering. It is implemented now
 * (`quickwitSortBy`), so this list and the API reference finally agree with
 * what the service does. */
export const SEARCH_SORTS = ["date_desc", "date_asc", "title_asc", "relevance"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-02-31` parses as a shape and is still not a day. Round-tripping is the
 * cheap way to tell the two apart without a calendar table. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** `"woord1 woord2"~10` is the proximity notation that sits next to the phrase
 * syntax in nearly every search engine. This one does not implement it, and the
 * `~10` fell straight through the phrase splitter into the loose terms, where
 * `10` was ANDed onto the query as an ordinary word.
 *
 * What makes it worth a 400 rather than a footnote is the direction of the
 * error. A slop can only *widen* a phrase, so whoever writes one expects at
 * least the bare phrase's hits. Measured on 2026-08-18: the bare phrase
 * returned 79.791 and the slop 34.107, less than half -- and the same words
 * with a loose `10` returned 35.118, which is what gave the cause away. A
 * reader concluding from that number that little has been decided on a subject
 * concludes the opposite of the truth (#224). */
const PHRASE_SLOP = /"[^"]*"~\d/;

function badRequest(error: string, hint?: string): Response {
  return Response.json(hint ? { error, hint } : { error }, { status: 400 });
}

export function validateSearchParams(url: URL): Response | null {
  const entityType = url.searchParams.get("entityType")?.trim() ?? "";
  if (entityType && !SEARCH_ENTITY_TYPES.includes(entityType)) {
    // `entityType=MEETINGS` used to drop the filter and return everything, so a
    // caller asking for meetings received documents -- the opposite of the
    // request -- and could only find out by inspecting every result.
    return badRequest(
      `Onbekend entityType "${entityType}".`,
      `Geldige waarden zijn ${SEARCH_ENTITY_TYPES.join(", ")}; let op hoofdletters.`,
    );
  }

  const organization = url.searchParams.get("organization")?.trim() ?? "";
  if (organization) {
    // Checked against the list /api/sources publishes, not against getSource: a
    // source can be withdrawn from importing and still hold years of indexed
    // data that searches perfectly well. Dongen is exactly that, and getSource
    // rejects it.
    const known = listAdminSourceOptions().some((source) => source.key === organization);
    if (!known) {
      return badRequest(
        `Onbekende organization "${organization}".`,
        "Zie /api/sources voor geldige keys; deze zijn hoofdlettergevoelig.",
      );
    }
  }

  const query = url.searchParams.get("query") ?? "";
  if (PHRASE_SLOP.test(query)) {
    return badRequest(
      'Nabijheidszoeken met een slop, zoals "woord1 woord2"~10, wordt niet ondersteund.',
      'Laat de `~10` weg voor een exacte frase ("woord1 woord2"), of zoek de woorden los zonder aanhalingstekens.',
    );
  }

  const sort = url.searchParams.get("sort")?.trim() ?? "";
  if (sort && !SEARCH_SORTS.includes(sort)) {
    // An unknown sort used to fall through to `date_desc`, so a caller who
    // asked for one order was answered in another with nothing saying so.
    return badRequest(
      `Onbekende sort "${sort}".`,
      `Geldige waarden zijn ${SEARCH_SORTS.join(", ")}.`,
    );
  }

  for (const name of ["dateFrom", "dateTo"]) {
    const raw = url.searchParams.get(name)?.trim() ?? "";
    if (!raw) {
      continue;
    }
    // The dangerous one of the three. An unreadable date was compared against
    // dates that are readable, which filtered every result away: a typo, or an
    // ISO value with a time on the end, answered HTTP 200 with zero results --
    // indistinguishable from a period in which nothing was decided.
    if (!isCalendarDate(raw)) {
      return badRequest(
        `Parameter ${name} moet een datum in de vorm JJJJ-MM-DD zijn, kreeg "${raw}".`,
        "Alleen de kale datum wordt geaccepteerd; een tijd of tijdzone erachter niet.",
      );
    }
  }

  for (const name of ["limit", "offset"]) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === "") {
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      return badRequest(`Parameter ${name} moet een geheel getal zijn, kreeg "${raw}".`);
    }
    // limit=0 and limit=-5 were clamped up to 1 and answered with a single
    // result, so a caller whose variable was accidentally zero got data back
    // instead of a signal.
    if (name === "limit" && value < 1) {
      return badRequest(`Parameter limit moet minstens 1 zijn, kreeg ${value}.`);
    }
    if (name === "offset" && value < 0) {
      return badRequest(`Parameter offset kan niet negatief zijn, kreeg ${value}.`);
    }
  }

  return null;
}
