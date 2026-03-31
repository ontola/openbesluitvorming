import type { SourceCatalogEntry } from "../types.ts";
import { sourceCatalog, sourceCatalogByRef } from "./catalog.generated.ts";

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
