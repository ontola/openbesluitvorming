import { ibabsSources } from "./ibabs.ts";
import { notubizSources } from "./notubiz.ts";
import type { AdminSourceOption, SourceDefinition } from "../types.ts";

const allSources = {
  ...notubizSources,
  ...ibabsSources,
} satisfies Record<string, SourceDefinition>;

export function getSource(key: string): SourceDefinition {
  const source = allSources[key];
  if (!source) {
    throw new Error(`Unknown source "${key}"`);
  }
  return source;
}

export function listSources(): SourceDefinition[] {
  return Object.values(allSources);
}

export function listAdminSourceOptions(): AdminSourceOption[] {
  return listSources().map((source) => ({
    key: source.key,
    label: source.label ?? source.key.replaceAll("_", " "),
  }));
}
