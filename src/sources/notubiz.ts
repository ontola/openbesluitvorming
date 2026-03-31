import type { NotubizSourceDefinition } from "../types.ts";

export const notubizSources: Record<string, NotubizSourceDefinition> = {
  haarlem: {
    key: "haarlem",
    supplier: "notubiz",
    notubizOrganizationId: 544,
    allmanakId: 38688,
  },
};

export function getNotubizSource(key: string): NotubizSourceDefinition {
  const source = notubizSources[key];
  if (!source) {
    throw new Error(`Unknown Notubiz source "${key}"`);
  }
  return source;
}
