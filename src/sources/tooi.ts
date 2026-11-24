// TOOI identifiers (Thesaurus en Ontologie Overheidsinformatie) for the
// organizations in the source catalog: the URIs the Dutch government uses to
// name its own bodies, and what DCAT-AP-NL expects as a dataset's publisher.
import type { SourceCatalogEntry } from "../types.ts";

export const TOOI_ID_BASE = "https://identifier.overheid.nl/tooi/id";

export interface TooiOrganization {
  /** The TOOI URI, e.g. https://identifier.overheid.nl/tooi/id/gemeente/gm0392. */
  uri: string;
  /** The organization's own name, with its kind: "Gemeente Haarlem". */
  name: string;
}

/** Provinces and water boards carry no CBS code in the catalog, so their TOOI
 * code is kept here, by catalog key. A gemeente needs no row: its code is its
 * CBS code (`gm` + four digits).
 *
 * Provinces are `pv` + the CBS province number. Water boards are `ws` + their
 * four-digit waterschapscode, which is *not* the CBS `WSnn` code (the catalog
 * gives Scheldestromen WS27; TOOI has ws0661). Codes and names were checked
 * against the TOOI value lists for provinces and water boards
 * (rwc_provincies_compleet, rwc_waterschappen_compleet), each water board
 * against two independent copies, in November 2026.
 *
 * Only implemented sources are listed. When a province or water board is
 * switched on, `tests/dcat_api.test.ts` fails until its code is added here. */
const NON_MUNICIPAL_TOOI: Record<
  string,
  { kind: "provincie" | "waterschap"; code: string; name: string }
> = {
  flevoland: { kind: "provincie", code: "pv24", name: "Provincie Flevoland" },
  fryslan: { kind: "provincie", code: "pv21", name: "Provincie Fryslân" },
  "noord-holland": { kind: "provincie", code: "pv27", name: "Provincie Noord-Holland" },
  overijssel: { kind: "provincie", code: "pv23", name: "Provincie Overijssel" },
  provincie_groningen: { kind: "provincie", code: "pv20", name: "Provincie Groningen" },
  provincie_limburg: { kind: "provincie", code: "pv31", name: "Provincie Limburg" },
  "provincie-utrecht": { kind: "provincie", code: "pv26", name: "Provincie Utrecht" },
  zuid_holland: { kind: "provincie", code: "pv28", name: "Provincie Zuid-Holland" },

  "aa-en-maas": { kind: "waterschap", code: "ws0654", name: "Waterschap Aa en Maas" },
  brabantse_delta: { kind: "waterschap", code: "ws0652", name: "Waterschap Brabantse Delta" },
  "de-dommel": { kind: "waterschap", code: "ws0539", name: "Waterschap De Dommel" },
  hollandse_delta: { kind: "waterschap", code: "ws0655", name: "Waterschap Hollandse Delta" },
  hoogheemraadschap_hollands_noorderkwartier: {
    kind: "waterschap",
    code: "ws0651",
    name: "Hoogheemraadschap Hollands Noorderkwartier",
  },
  hoogheemraadschap_van_delfland: {
    kind: "waterschap",
    code: "ws0372",
    name: "Hoogheemraadschap van Delfland",
  },
  "hunze-en-aa": { kind: "waterschap", code: "ws0646", name: "Waterschap Hunze en Aa's" },
  scheldestromen: { kind: "waterschap", code: "ws0661", name: "Waterschap Scheldestromen" },
  vechtstromen: { kind: "waterschap", code: "ws0663", name: "Waterschap Vechtstromen" },
  waterschap_amstel_gooi_en_vecht: {
    kind: "waterschap",
    code: "ws0155",
    name: "Waterschap Amstel, Gooi en Vecht",
  },
  waterschap_limburg: { kind: "waterschap", code: "ws0665", name: "Waterschap Limburg" },
  wetterskip_fryslan: { kind: "waterschap", code: "ws0653", name: "Wetterskip Fryslân" },
  zuiderzeeland: { kind: "waterschap", code: "ws0650", name: "Waterschap Zuiderzeeland" },
};

/** The TOOI organization behind a catalog source, or undefined when it cannot
 * be named with certainty. Several sources can share one: Amsterdam's
 * stadsdelen are all the gemeente Amsterdam, and `municipalityLabel` gives the
 * name to use for it (the catalog label of the main source). */
export function tooiOrganization(
  source: Pick<SourceCatalogEntry, "key" | "label" | "organizationType" | "cbsId">,
  municipalityLabel?: string,
): TooiOrganization | undefined {
  if (source.organizationType === "gemeente") {
    if (!source.cbsId || !/^GM\d{4}$/.test(source.cbsId)) {
      return undefined;
    }
    return {
      uri: `${TOOI_ID_BASE}/gemeente/${source.cbsId.toLowerCase()}`,
      name: `Gemeente ${municipalityLabel ?? source.label ?? source.key}`,
    };
  }
  const row = NON_MUNICIPAL_TOOI[source.key];
  if (!row || row.kind !== source.organizationType) {
    return undefined;
  }
  return { uri: `${TOOI_ID_BASE}/${row.kind}/${row.code}`, name: row.name };
}
