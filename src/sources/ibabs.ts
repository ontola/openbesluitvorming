import type { IbabsSourceDefinition } from "../types.ts";

export const ibabsSources: Record<string, IbabsSourceDefinition> = {
  amstelveen: {
    key: "amstelveen",
    label: "Gemeente Amstelveen (iBabs)",
    supplier: "ibabs",
    organizationType: "gemeente",
    ibabsSitename: "amstelveen",
    allmanakId: 28270,
    cbsId: "GM0362",
  },
  utrecht: {
    key: "utrecht",
    label: "Gemeente Utrecht (iBabs)",
    supplier: "ibabs",
    organizationType: "gemeente",
    ibabsSitename: "utrecht",
    allmanakId: 38122,
    cbsId: "GM0344",
  },
  "noord-holland": {
    key: "noord-holland",
    label: "Provincie Noord-Holland (iBabs)",
    supplier: "ibabs",
    organizationType: "provincie",
    ibabsSitename: "noord-holland",
    allmanakId: 16412,
  },
  limburg: {
    key: "limburg",
    label: "Provincie Limburg (iBabs)",
    supplier: "ibabs",
    organizationType: "provincie",
    ibabsSitename: "limburg",
    allmanakId: 16071,
  },
};

export function getIbabsSource(key: string): IbabsSourceDefinition {
  const source = ibabsSources[key];
  if (!source) {
    throw new Error(`Unknown iBabs source "${key}"`);
  }
  return source;
}
