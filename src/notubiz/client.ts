import type { NotubizOrganizationAttributes } from "../types.ts";

const DEFAULT_QUERY = "format=json&version=1.17.0";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;

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

  const message = `${error.name} ${error.message}`.toLowerCase();
  return (
    message.includes("error reading a body from connection") ||
    message.includes("connection reset") ||
    message.includes("broken pipe") ||
    message.includes("timed out") ||
    message.includes("dns error") ||
    message.includes("client error") ||
    message.includes("unknownerror") ||
    message.includes("failed to fetch")
  );
}

function describeTransportError(url: string, error: unknown): Error {
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
        headers: {
          accept: "application/json",
          "user-agent": "woozi/0.1",
        },
      });

      if (!response.ok) {
        throw new Error(`Request failed ${response.status} for ${url}`);
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

async function fetchBytes(url: string): Promise<Uint8Array> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "*/*",
          "user-agent": "woozi/0.1",
        },
      });

      if (!response.ok) {
        throw new Error(`Request failed ${response.status} for ${url}`);
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
  private mapOrganizationAttributes(
    organization: {
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
    },
  ): NotubizOrganizationAttributes {
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
