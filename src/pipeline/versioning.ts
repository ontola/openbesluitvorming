export function currentProjectionVersion(): string {
  // `search-v3-meeting-date` maps start_date as a datetime fast field so search
  // can sort and range on the meeting date (#184). It stays opt-in rather than
  // becoming the default, because doc mappings are fixed at index creation: v3
  // needs a *new* index, and scoping queries to it before that index has been
  // reindexed empties search for as long as the reindex takes. Set it together
  // with a new QUICKWIT_INDEX_ID — see deployment.md.
  //
  // Deploying the v3 code against a v2 index is safe on its own: Quickwit
  // ignores both sort_by and a range clause on a field its mapping does not
  // declare (verified on 0.8.1, no error), so search behaves exactly as before.
  return Deno.env.get("WOOZI_PROJECTION_VERSION")?.trim() || "search-v2-pages";
}

export function currentDerivationVersion(): string {
  return Deno.env.get("WOOZI_DERIVATION_VERSION")?.trim() || "pymupdf-v1";
}
