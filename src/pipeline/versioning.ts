export function currentProjectionVersion(): string {
  return Deno.env.get("WOOZI_PROJECTION_VERSION")?.trim() || "search-v2-pages";
}

export function currentDerivationVersion(): string {
  return Deno.env.get("WOOZI_DERIVATION_VERSION")?.trim() || "pymupdf-v1";
}
