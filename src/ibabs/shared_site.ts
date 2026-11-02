import { listRunnableCatalogSources } from "../sources/index.ts";
import type { IbabsSourceDefinition } from "../types.ts";

/** Labels of the other organizations we import from the same iBabs site.
 *
 * A few municipalities that share a civil service publish through one site:
 * Druten and Wijchen on `wdw`, Voorschoten and Wassenaar on `Duivenvoorde`.
 * Each source imported the whole site, so every meeting and document showed
 * up under both organizations (#339). The site gives no organization per
 * meeting; the meeting type's name is the only place that says, as in
 * "Raad openbaar Druten" or "Commissievergadering Wijchen". */
export function ibabsSiteSiblingLabels(source: IbabsSourceDefinition): string[] {
  return listRunnableCatalogSources()
    .filter(
      (entry) =>
        entry.supplier === "ibabs" &&
        entry.key !== source.key &&
        entry.ibabsSitename?.toLowerCase() === source.ibabsSitename.toLowerCase(),
    )
    .map((entry) => entry.label)
    .filter((label): label is string => Boolean(label));
}

function namesOrganization(name: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, "iu").test(name);
}

/** Does `name` (a meeting type or register name) belong to a sibling on the
 * same site rather than to `ownLabel`?
 *
 * Only when it names a sibling and not this organization. A name that names
 * neither, a joint meeting, or a meeting without a type name stays with
 * every organization on the site: a duplicate is better than a meeting that
 * is missing from both. */
export function belongsToSiteSibling(
  name: string | undefined,
  ownLabel: string | undefined,
  siblingLabels: string[],
): boolean {
  if (!name || siblingLabels.length === 0) {
    return false;
  }
  if (ownLabel && namesOrganization(name, ownLabel)) {
    return false;
  }
  return siblingLabels.some((label) => namesOrganization(name, label));
}
