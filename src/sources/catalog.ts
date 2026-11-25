import type { SourceCatalogEntry } from "../types.ts";
import { sourceCatalog } from "./catalog.data.ts";
import { configuredOdsSources, toOdsCatalogEntry } from "../ods/sources.ts";

interface CatalogIndex {
  entries: SourceCatalogEntry[];
  byKey: Record<string, SourceCatalogEntry>;
  byRef: Record<string, SourceCatalogEntry>;
}

/** The ORI catalog plus the ODS feed sources this deployment declares
 * (src/ods/sources.ts). Built on first use, so an environment set
 * before the first lookup is the one that counts. */
let index: CatalogIndex | undefined;

function catalogIndex(): CatalogIndex {
  if (index) {
    return index;
  }
  const entries: SourceCatalogEntry[] = [
    ...sourceCatalog,
    ...configuredOdsSources().map(toOdsCatalogEntry),
  ];
  const byKey: Record<string, SourceCatalogEntry> = {};
  const byRef: Record<string, SourceCatalogEntry> = {};
  const duplicates = new Set<string>();

  for (const source of entries) {
    byRef[source.sourceRef] = source;
    if (byKey[source.key]) {
      duplicates.add(source.key);
      continue;
    }
    byKey[source.key] = source;
  }

  if (duplicates.size > 0) {
    // An ODS source with the key of a catalog organisation would file its
    // meetings under someone else's ids. Moving a council from its old
    // supplier to a feed means changing that catalog entry, not adding a
    // second one.
    throw new Error(
      `Duplicate source key(s) in source catalog: ${[...duplicates].sort((left, right) => left.localeCompare(right, "nl")).join(", ")}`,
    );
  }

  index = { entries, byKey, byRef };
  return index;
}

export function listCatalogSources(): SourceCatalogEntry[] {
  return catalogIndex().entries;
}

export function listImplementedCatalogSources(): SourceCatalogEntry[] {
  return catalogIndex().entries.filter((source) => source.implemented);
}

export function getCatalogSourceByRef(sourceRef: string): SourceCatalogEntry {
  const source = catalogIndex().byRef[sourceRef];
  if (!source) {
    throw new Error(`Unknown source reference "${sourceRef}"`);
  }
  return source;
}

export function getCatalogSourceByKey(sourceKey: string): SourceCatalogEntry {
  const source = catalogIndex().byKey[sourceKey];
  if (!source) {
    throw new Error(`Unknown source "${sourceKey}"`);
  }
  return source;
}
