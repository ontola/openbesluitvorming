import type { SourceInfo } from "../types.ts";

/** Every object-storage root a source writes into.
 *
 * Purging a source has to clear all of them. This list exists because it did
 * not: `purge_source` deleted `documents/` only, so a purged source kept its
 * transcripts — exactly the text a takedown is meant to remove. Anything that
 * starts writing under a new root belongs here on the same commit.
 */
export const STORAGE_ROOTS = ["documents", "recordings"] as const;

export type StorageRoot = (typeof STORAGE_ROOTS)[number];

/** The prefix one source occupies under one root, always trailing-slashed so a
 * prefix delete cannot spill into a neighbour whose key starts the same way
 * ("bergen" must not match "bergen_nh"). */
export function storagePrefix(
  root: StorageRoot,
  source: { supplier: string; organizationType?: string; key: string },
): string {
  const organizationType = source.organizationType ?? "onbekend";
  return `${root}/${source.supplier}/${organizationType}/${source.key}/`;
}

/** Same, from the `source_info` an entity carries. */
export function storagePrefixForSourceInfo(root: StorageRoot, sourceInfo: SourceInfo): string {
  return storagePrefix(root, {
    supplier: sourceInfo.supplier,
    organizationType: sourceInfo.organization_type,
    key: sourceInfo.source,
  });
}

/** Everything a purge has to clear for one source. */
export function sourceStoragePrefixes(source: {
  supplier: string;
  organizationType?: string;
  key: string;
}): string[] {
  return STORAGE_ROOTS.map((root) => storagePrefix(root, source));
}
