import { canonicalOrganizationId, canonicalPartyId, canonicalPersonId } from "../ids.ts";
import type {
  PartyEntity,
  PersonEntity,
  SourceDefinitionBase,
  SourceInfo,
} from "../types.ts";
import type { AllmanakCouncilMember, AllmanakPartySeat } from "./client.ts";

function allmanakSourceInfo(source: SourceDefinitionBase): SourceInfo {
  return {
    supplier: "allmanak",
    source: source.key,
    organization_type: source.organizationType,
    canonical_id: source.key,
  };
}

function allmanakScopedSource(source: SourceDefinitionBase): SourceDefinitionBase {
  return {
    key: source.key,
    label: source.label,
    supplier: "allmanak",
    organizationType: source.organizationType,
    allmanakId: source.allmanakId,
    cbsId: source.cbsId,
  };
}

export function normalizeAllmanakParties(
  source: SourceDefinitionBase,
  seats: AllmanakPartySeat[],
): PartyEntity[] {
  const allmanakSource = allmanakScopedSource(source);
  const orgId = canonicalOrganizationId(source);
  const partiesById = new Map<string, PartyEntity>();

  for (const seat of seats) {
    const name = seat.partij ?? seat.naam;
    if (!name) {
      continue;
    }

    const id = canonicalPartyId(allmanakSource, name);
    partiesById.set(id, {
      id,
      type: "Party",
      name,
      classification: ["Party"],
      subOrganizationOf: orgId,
      source_info: allmanakSourceInfo(source),
      raw: seat,
    });
  }

  return [...partiesById.values()];
}

function detectGender(name: string): string | undefined {
  if (name.includes("Dhr.")) {
    return "Man";
  }
  if (name.includes("Mw.")) {
    return "Vrouw";
  }
  return undefined;
}

export function normalizeAllmanakPersons(
  source: SourceDefinitionBase,
  people: AllmanakCouncilMember[],
): PersonEntity[] {
  const allmanakSource = allmanakScopedSource(source);
  const orgId = canonicalOrganizationId(source);

  return people
    .filter((person) => Boolean(person?.systemid) && typeof person.naam === "string")
    .map((person) => {
      const id = canonicalPersonId(allmanakSource, person.systemid);
      const partyId = person.partij ? canonicalPartyId(allmanakSource, person.partij) : undefined;
      return {
        id,
        type: "Person",
        name: person.naam,
        gender: detectGender(person.naam),
        organization: orgId,
        party: partyId,
        source_info: allmanakSourceInfo(source),
        raw: person,
      };
    });
}

