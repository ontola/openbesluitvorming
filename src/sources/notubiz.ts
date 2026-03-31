import type { NotubizSourceDefinition } from "../types.ts";

export const notubizSources: Record<string, NotubizSourceDefinition> = {
  alkmaar: {
    key: "alkmaar",
    label: "Gemeente Alkmaar",
    supplier: "notubiz",
    organizationType: "gemeente",
    notubizOrganizationId: 987,
    allmanakId: 38624,
  },
  amsterdam: {
    key: "amsterdam",
    label: "Gemeente Amsterdam",
    supplier: "notubiz",
    organizationType: "gemeente",
    notubizOrganizationId: 281,
    allmanakId: 25698,
  },
  amersfoort: {
    key: "amersfoort",
    label: "Gemeente Amersfoort",
    supplier: "notubiz",
    organizationType: "gemeente",
    notubizOrganizationId: 867,
    allmanakId: 35134,
  },
  delft: {
    key: "delft",
    label: "Gemeente Delft",
    supplier: "notubiz",
    organizationType: "gemeente",
    notubizOrganizationId: 550,
    allmanakId: 39076,
  },
  haarlem: {
    key: "haarlem",
    label: "Gemeente Haarlem",
    supplier: "notubiz",
    organizationType: "gemeente",
    notubizOrganizationId: 544,
    allmanakId: 38688,
  },
  leiden: {
    key: "leiden",
    label: "Gemeente Leiden",
    supplier: "notubiz",
    organizationType: "gemeente",
    notubizOrganizationId: 271,
    allmanakId: 26226,
  },
  zaanstad: {
    key: "zaanstad",
    label: "Gemeente Zaanstad",
    supplier: "notubiz",
    organizationType: "gemeente",
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
