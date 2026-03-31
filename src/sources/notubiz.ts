import type { NotubizSourceDefinition } from "../types.ts";

export const notubizSources: Record<string, NotubizSourceDefinition> = {
  alkmaar: {
    key: "alkmaar",
    supplier: "notubiz",
    notubizOrganizationId: 987,
    allmanakId: 38624,
  },
  amsterdam: {
    key: "amsterdam",
    supplier: "notubiz",
    notubizOrganizationId: 281,
    allmanakId: 25698,
  },
  amersfoort: {
    key: "amersfoort",
    supplier: "notubiz",
    notubizOrganizationId: 867,
    allmanakId: 35134,
  },
  delft: {
    key: "delft",
    supplier: "notubiz",
    notubizOrganizationId: 550,
    allmanakId: 39076,
  },
  haarlem: {
    key: "haarlem",
    supplier: "notubiz",
    notubizOrganizationId: 544,
    allmanakId: 38688,
  },
  leiden: {
    key: "leiden",
    supplier: "notubiz",
    notubizOrganizationId: 271,
    allmanakId: 26226,
  },
  zaanstad: {
    key: "zaanstad",
    supplier: "notubiz",
    notubizOrganizationId: 801,
    allmanakId: 27115,
  },
};

export function getNotubizSource(key: string): NotubizSourceDefinition {
  const source = notubizSources[key];
  if (!source) {
    throw new Error(`Unknown Notubiz source "${key}"`);
  }
  return source;
}
