import type { OrganizationType, SourceCatalogEntry } from "../types.ts";

/** An organisation whose raadsinformatie we read from an ODS Open
 * Raadsinformatie event polling feed (version 0.0.3): `/snapshot` once, then
 * `/feed` with a cursor. OpenMeeting is the first system that offers one;
 * any other system that implements the same spec works with the same code.
 *
 * These are not in the ORI catalog (`catalog.data.ts`), which is the legacy
 * list of organisations we read through a supplier's own API. Each deployment
 * declares its own in `WOOZI_ODS_SOURCES`, a JSON array:
 *
 *   [{"key":"eemdal","label":"Eemdal","organizationType":"gemeente",
 *     "organisatiecode":"gm9999","feedUrl":"https://eemdal.example/ori/v1"}]
 *
 * `feedUrl` is the feed's base URL: the one that serves the servicedocument
 * at `/`, with `/feed` and `/snapshot` below it. The feed is public by
 * definition (the spec has no authentication), so there is no token.
 *
 * Read from `Deno.env` synchronously, because the catalog is built when its
 * module loads. In Docker the variable comes in through the environment. */
export interface OdsSourceConfig {
  key: string;
  label: string;
  organizationType: OrganizationType;
  /** TOOI code, lower case: gm0363, pv27, ws0654. Also the feed's
   * `organisatiecode` filter, so one feed can serve several organisations. */
  organisatiecode: string;
  feedUrl: string;
  cbsId?: string;
  allmanakId?: number;
}

const ORGANIZATION_TYPES = new Set<OrganizationType>(["gemeente", "provincie", "waterschap"]);
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** The spec's Organisatiecode pattern. */
const ORGANISATIECODE_PATTERN = /^(gm[0-9]{4}|pv[0-9]{2}|ws[0-9]{4})$/;

export function parseOdsSources(raw: string | undefined): OdsSourceConfig[] {
  if (!raw?.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `WOOZI_ODS_SOURCES is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("WOOZI_ODS_SOURCES must be a JSON array");
  }
  return parsed.map((entry, index) => {
    const where = `WOOZI_ODS_SOURCES[${index}]`;
    if (!entry || typeof entry !== "object") {
      throw new Error(`${where} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    const key = typeof value.key === "string" ? value.key.trim() : "";
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`${where}.key must be lowercase letters, digits, _ or -`);
    }
    const organizationType = value.organizationType ?? "gemeente";
    if (!ORGANIZATION_TYPES.has(organizationType as OrganizationType)) {
      throw new Error(`${where}.organizationType must be gemeente, provincie or waterschap`);
    }
    const organisatiecode =
      typeof value.organisatiecode === "string" ? value.organisatiecode.trim().toLowerCase() : "";
    if (!ORGANISATIECODE_PATTERN.test(organisatiecode)) {
      throw new Error(`${where}.organisatiecode must be a TOOI code such as gm0363`);
    }
    const feedUrl = typeof value.feedUrl === "string" ? value.feedUrl.trim() : "";
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(feedUrl);
    } catch {
      parsedUrl = undefined;
    }
    if (!parsedUrl || (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")) {
      throw new Error(`${where}.feedUrl must be an http(s) URL`);
    }
    return {
      key,
      label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : key,
      organizationType: organizationType as OrganizationType,
      organisatiecode,
      feedUrl: feedUrl.replace(/\/+$/, ""),
      cbsId: typeof value.cbsId === "string" ? value.cbsId : undefined,
      allmanakId: typeof value.allmanakId === "number" ? value.allmanakId : undefined,
    };
  });
}

export function odsSourceRef(config: { key: string; organizationType: string }): string {
  return `ods:${config.organizationType}:${config.key}`;
}

export function toOdsCatalogEntry(config: OdsSourceConfig): SourceCatalogEntry {
  return {
    sourceRef: odsSourceRef(config),
    key: config.key,
    label: config.label,
    sourceName: config.label,
    supplier: "ods",
    organizationType: config.organizationType,
    // 0: no Allmanak lookup. The feed names its own gremia.
    allmanakId: config.allmanakId ?? 0,
    cbsId: config.cbsId ?? config.organisatiecode.toUpperCase(),
    organisatiecode: config.organisatiecode,
    odsFeedUrl: config.feedUrl,
    legacyConfigFile: "",
    legacyConfigRoot: "",
    implemented: true,
  };
}

let configured: OdsSourceConfig[] | undefined;

/** The deployment's ODS feed sources, parsed once. */
export function configuredOdsSources(): OdsSourceConfig[] {
  configured ??= parseOdsSources(Deno.env.get("WOOZI_ODS_SOURCES"));
  return configured;
}
