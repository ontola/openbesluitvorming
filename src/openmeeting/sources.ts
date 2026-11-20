import type { OrganizationType, SourceCatalogEntry } from "../types.ts";

/** A council that publishes from OpenMeeting, as configured for this
 * deployment.
 *
 * These are not in the ORI catalog (`catalog.data.ts`): that one is the
 * legacy list of organisations we poll, and an OpenMeeting council pushes to
 * us. Each deployment declares its own in `WOOZI_OPENMEETING_SOURCES`, a JSON
 * array:
 *
 *   [{"key":"eemdal","label":"Eemdal","organizationType":"gemeente",
 *     "cbsId":"GM9999","token":"<long random secret>"}]
 *
 * The token is what `PUT /api/publish/{key}/...` must carry as a bearer
 * token. It stays here and never reaches the catalog, so it cannot leak
 * through `/api/sources`.
 *
 * Read from `Deno.env` synchronously, because the catalog is built when its
 * module loads. In Docker the variable comes in through `env_file`. */
export interface OpenMeetingSourceConfig {
  key: string;
  label: string;
  organizationType: OrganizationType;
  cbsId?: string;
  allmanakId?: number;
  token: string;
}

const ORGANIZATION_TYPES = new Set<OrganizationType>(["gemeente", "provincie", "waterschap"]);
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** Short enough to guess is short enough to refuse. */
const MIN_TOKEN_LENGTH = 24;

export function parseOpenMeetingSources(raw: string | undefined): OpenMeetingSourceConfig[] {
  if (!raw?.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `WOOZI_OPENMEETING_SOURCES is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("WOOZI_OPENMEETING_SOURCES must be a JSON array");
  }
  return parsed.map((entry, index) => {
    const where = `WOOZI_OPENMEETING_SOURCES[${index}]`;
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
    const token = typeof value.token === "string" ? value.token : "";
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`${where}.token must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
    return {
      key,
      label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : key,
      organizationType: organizationType as OrganizationType,
      cbsId: typeof value.cbsId === "string" ? value.cbsId : undefined,
      allmanakId: typeof value.allmanakId === "number" ? value.allmanakId : undefined,
      token,
    };
  });
}

export function openMeetingSourceRef(config: { key: string; organizationType: string }): string {
  return `openmeeting:${config.organizationType}:${config.key}`;
}

export function toOpenMeetingCatalogEntry(config: OpenMeetingSourceConfig): SourceCatalogEntry {
  return {
    sourceRef: openMeetingSourceRef(config),
    key: config.key,
    label: config.label,
    sourceName: config.label,
    supplier: "openmeeting",
    organizationType: config.organizationType,
    // 0: no Allmanak lookup. OpenMeeting sends its own committees.
    allmanakId: config.allmanakId ?? 0,
    cbsId: config.cbsId,
    legacyConfigFile: "",
    legacyConfigRoot: "",
    implemented: true,
  };
}

let configured: OpenMeetingSourceConfig[] | undefined;

/** The deployment's OpenMeeting sources, parsed once. */
export function configuredOpenMeetingSources(): OpenMeetingSourceConfig[] {
  configured ??= parseOpenMeetingSources(Deno.env.get("WOOZI_OPENMEETING_SOURCES"));
  return configured;
}
