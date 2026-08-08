export function currentProjectionVersion(): string {
  // `search-v3-meeting-date` maps start_date as a datetime fast field so search
  // can sort and range on the meeting date (#184). It stays opt-in rather than
  // becoming the default, because doc mappings are fixed at index creation: v3
  // needs a *new* index, and scoping queries to it before that index has been
  // reindexed empties search for as long as the reindex takes. Set it together
  // with a new QUICKWIT_INDEX_ID — see deployment.md.
  //
  return Deno.env.get("WOOZI_PROJECTION_VERSION")?.trim() || "search-v2-pages";
}

/** Whether the index this projection queries maps `start_date` as a datetime
 * fast field, and can therefore be asked to sort on it.
 *
 * This guard exists because the opposite was assumed and was wrong. The claim
 * was that Quickwit ignores `sort_by` on a field the mapping does not declare,
 * so v3 code against a v2 index would behave as before. It does not ignore it:
 * in a v2 index `start_date` still exists, as a *dynamic string*, and 0.8.1
 * answers every query with
 *   500 "Unsupported sort field type `Str`".
 * Deploying that combination took search down completely (2026-08-08). Sorting
 * therefore has to be tied to the mapping, not left to the engine to shrug off.
 */
export function projectionSupportsDateSort(): boolean {
  return currentProjectionVersion() !== "search-v2-pages";
}

export function currentDerivationVersion(): string {
  return Deno.env.get("WOOZI_DERIVATION_VERSION")?.trim() || "pymupdf-v1";
}
