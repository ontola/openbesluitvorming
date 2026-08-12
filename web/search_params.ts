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
