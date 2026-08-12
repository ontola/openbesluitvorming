import type {
  NotubizMedia,
  NotubizModule,
  NotubizModuleItem,
  NotubizOrganizationAttributes,
} from "../types.ts";

const DEFAULT_QUERY = "format=json&version=1.17.0";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;
// Cap each HTTP call so a hung connection can't wedge an ingest slot.
const FETCH_TIMEOUT_MS = 90_000;

function buildUrl(path: string, params: Record<string, string | number> = {}): string {
  const url = new URL(`https://api.notubiz.nl/${path}`);
  url.search = DEFAULT_QUERY;
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }

  const message = `${error.name} ${error.message}`.toLowerCase();
  return (
    message.includes("error reading a body from connection") ||
    message.includes("connection reset") ||
    message.includes("broken pipe") ||
    message.includes("timed out") ||
    message.includes("dns error") ||
    message.includes("client error") ||
    message.includes("unknownerror") ||
    message.includes("failed to fetch") ||
    // Deno's wording when the connection cannot be established at all. The
    // iBabs client already learned this one; the same omission here cost 22 of
    // 128 sources in the first media backfill (2026-08-11), where it was the
    // only transport failure that got no retry and so failed the whole run.
    message.includes("error sending request")
  );
}

/** An HTTP response that arrived and said no.
 *
 * Kept apart from transport failures because conflating the two sent a
 * diagnosis down the wrong path for half an hour: Purmerend and Dongen were
 * answering a clean `404` with a JSON body, and both were reported as
 * "Request transport failed", so the investigation went looking at connections
 * and concurrency while the server was replying perfectly well. */
export class NotubizHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    const detail = body.trim().slice(0, 200);
    super(`Request failed ${status} for ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "NotubizHttpError";
  }
}

function describeTransportError(url: string, error: unknown): Error {
  // An answered request is not a transport problem; hand it through unchanged.
  if (error instanceof NotubizHttpError) {
    return error;
  }

  if (error instanceof Error) {
    const name = error.name?.trim() || "Error";
    const message = error.message?.trim();
    const summary = message && message !== name ? `${name}: ${message}` : name;
    return new Error(`Request transport failed for ${url}: ${summary}`, {
      cause: message && message !== name ? `${name}: ${message}` : name,
    });
  }

  return new Error(`Request transport failed for ${url}: ${String(error)}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          "user-agent": "woozi/0.1",
        },
      });

      if (!response.ok) {
        throw new NotubizHttpError(response.status, url, await response.text().catch(() => ""));
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryableError(error)) {
        throw describeTransportError(url, error);
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw describeTransportError(url, lastError);
}

/** Notubiz returns media URLs without a scheme, and with raw spaces in the
 * `file=` parameter ("api.notubiz.nl/media/download?folder=X&file=10.06 en
 * 11.06.26 RAAD.mp4"). Both have to be fixed before the URL is usable. */
export function notubizMediaUrl(value: string): string {
  const absolute = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  // Only encode what is already unescaped, so calling this twice is harmless.
  return encodeURI(decodeURI(absolute));
}

async function fetchText(url: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          accept: "text/plain,*/*",
          "user-agent": "woozi/0.1",
        },
      });

      if (!response.ok) {
        throw new NotubizHttpError(response.status, url, await response.text().catch(() => ""));
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryableError(error)) {
        throw describeTransportError(url, error);
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw describeTransportError(url, lastError);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          accept: "*/*",
          "user-agent": "woozi/0.1",
        },
      });

      if (!response.ok) {
        throw new NotubizHttpError(response.status, url, await response.text().catch(() => ""));
      }

      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryableError(error)) {
        throw describeTransportError(url, error);
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw describeTransportError(url, lastError);
}

function fallbackDocumentUrl(document: unknown): string | undefined {
  if (!document || typeof document !== "object") {
    return undefined;
  }

  const value = (document as Record<string, unknown>).url;
  return typeof value === "string" ? value : undefined;
}

export class NotubizClient {
  private mapOrganizationAttributes(organization: {
    settings?: {
      folder?: {
        fields?: {
          field?: Array<{
            "@attributes": { id: string };
            label: string;
          }>;
        };
      };
    };
  }): NotubizOrganizationAttributes {
    const fields = organization.settings?.folder?.fields?.field ?? [];
    const attributes: Record<string, string> = {};
    for (const field of fields) {
      attributes[field["@attributes"].id] = field.label;
    }
    return { attributes };
  }

  async getOrganizationAttributes(organizationId: number): Promise<NotubizOrganizationAttributes> {
    type OrganizationsResponse = {
      organisations: {
        organisation: Array<{
          "@attributes": { id: string };
          settings?: {
            folder?: {
              fields?: {
                field?: Array<{
                  "@attributes": { id: string };
                  label: string;
                }>;
              };
            };
          };
        }>;
      };
    };
    type OrganizationResponse = {
      organisation: {
        settings?: {
          folder?: {
            fields?: {
              field?: Array<{
                "@attributes": { id: string };
                label: string;
              }>;
            };
          };
        };
      };
    };

    const data = await fetchJson<OrganizationsResponse>(buildUrl("organisations"));
    const org = data.organisations.organisation.find(
      (item) => Number(item["@attributes"].id) === organizationId,
    );

    if (org) {
      return this.mapOrganizationAttributes(org);
    }

    try {
      const direct = await fetchJson<OrganizationResponse>(
        buildUrl(`organisations/${organizationId}`),
      );
      return this.mapOrganizationAttributes(direct.organisation);
    } catch {
      // Some live Notubiz organisations are queryable via their event endpoints while omitted
      // from the global organisations listing and without folder field metadata. Keep ingesting
      // those organisations and fall back to generic meeting titles instead of aborting entirely.
      return { attributes: {} };
    }
  }

  async listEvents(
    organizationId: number,
    dateFrom: string,
    dateTo: string,
    page: number,
  ): Promise<unknown> {
    return await fetchJson(
      buildUrl("events", {
        organisation_id: organizationId,
        date_from: `${dateFrom} 00:00:00`,
        date_to: `${dateTo} 23:59:59`,
        page,
      }),
    );
  }

  async getMeeting(meetingId: number): Promise<unknown> {
    return await fetchJson(buildUrl(`events/meetings/${meetingId}`));
  }

  /** Registries configured for an organisation (Moties, Toezeggingen, …). */
  async listModules(organizationId: number): Promise<NotubizModule[]> {
    const data = await fetchJson<{ modules?: NotubizModule[] }>(
      buildUrl(`organisations/${organizationId}/modules`),
    );
    return Array.isArray(data.modules) ? data.modules : [];
  }

  /** Entries in one registry, filtered on the entry's own date.
   *
   * Without `date_from`/`date_to` this returns the organisation's entire
   * history in one response — 4.8 MB and ~36s for Alkmaar's 1331 moties, and
   * it frequently 504s. The filter narrows that to the run window. */
  async listModuleItems(
    organizationId: number,
    moduleId: number,
    dateFrom: string,
    dateTo: string,
  ): Promise<NotubizModuleItem[]> {
    const data = await fetchJson<{ items?: NotubizModuleItem[] }>(
      buildUrl(`organisations/${organizationId}/modules/${moduleId}/items`, {
        date_from: `${dateFrom} 00:00:00`,
        date_to: `${dateTo} 23:59:59`,
      }),
    );
    return Array.isArray(data.items) ? data.items : [];
  }

  /** Video/audio registrations of one meeting.
   *
   * There is no bulk variant: `organisation_id` is rejected with "Required
   * parameter: event_id", so this is one call per meeting. Meetings without a
   * registration return an empty list, which is the normal case for roughly
   * half of them. */
  async listMedia(meetingId: number): Promise<NotubizMedia[]> {
    const data = await fetchJson<{ media?: NotubizMedia[] }>(
      buildUrl("media", { event_id: meetingId }),
    );
    return Array.isArray(data.media) ? data.media : [];
  }

  /** The SRT transcript belonging to a media file, as text. */
  async downloadSubtitles(media: NotubizMedia): Promise<string> {
    if (!media.subtitles_url) {
      throw new Error(`Media ${media.id} has no subtitles URL`);
    }
    return await fetchText(notubizMediaUrl(media.subtitles_url));
  }

  async downloadDocument(document: unknown): Promise<Uint8Array> {
    const record =
      document && typeof document === "object" ? (document as Record<string, unknown>) : {};
    const primaryUrl = typeof record.original_url === "string" ? record.original_url : undefined;
    if (!primaryUrl) {
      throw new Error("Document has no download URL");
    }

    const target = primaryUrl.includes("format=") ? primaryUrl : `${primaryUrl}?${DEFAULT_QUERY}`;

    try {
      return await fetchBytes(target);
    } catch (error) {
      const fallbackUrl = fallbackDocumentUrl(record.raw);
      if (
        error instanceof Error &&
        error.message.includes("Request failed 403") &&
        fallbackUrl &&
        fallbackUrl !== primaryUrl
      ) {
        const fallbackTarget = fallbackUrl.includes("format=")
          ? fallbackUrl
          : `${fallbackUrl}?${DEFAULT_QUERY}`;
        return await fetchBytes(fallbackTarget);
      }
      throw error;
    }
  }
}
export const __test__ = { isRetryableError, notubizMediaUrl };
