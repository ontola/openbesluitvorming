import type { SourceCatalogEntry } from "../types.ts";
import { sourceCatalog, sourceCatalogByRef } from "./catalog.data.ts";

const sourceCatalogByKey = (() => {
  const entries: Record<string, SourceCatalogEntry> = {};
  const duplicates = new Set<string>();

  for (const source of sourceCatalog) {
    if (entries[source.key]) {
      duplicates.add(source.key);
      continue;
    }
    entries[source.key] = source;
  }

  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate source key(s) in source catalog: ${[...duplicates].sort((left, right) => left.localeCompare(right, "nl")).join(", ")}`,
    );
  }

  return entries;
})();

export function listCatalogSources(): SourceCatalogEntry[] {
  return sourceCatalog;
}

export function listImplementedCatalogSources(): SourceCatalogEntry[] {
  return sourceCatalog.filter((source) => source.implemented);
}

export function getCatalogSourceByRef(sourceRef: string): SourceCatalogEntry {
  const source = sourceCatalogByRef[sourceRef];
  if (!source) {
    throw new Error(`Unknown source reference "${sourceRef}"`);
  }
  return source;
}

export function getCatalogSourceByKey(sourceKey: string): SourceCatalogEntry {
  const source = sourceCatalogByKey[sourceKey];
  if (!source) {
    throw new Error(`Unknown source "${sourceKey}"`);
  }
  return source;
}
