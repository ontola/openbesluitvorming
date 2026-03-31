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

  const message = error.message.toLowerCase();
  return (
    message.includes("error reading a body from connection") ||
    message.includes("connection reset") ||
    message.includes("broken pipe") ||
    message.includes("timed out") ||
    message.includes("dns error") ||
    message.includes("client error")
  );
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
        throw error;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
}

export class NotubizClient {
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

    const data = await fetchJson<OrganizationsResponse>(buildUrl("organisations"));
    const org = data.organisations.organisation.find(
      (item) => Number(item["@attributes"].id) === organizationId,
    );

    if (!org) {
      throw new Error(`Organization ${organizationId} not found in /organisations`);
    }

    const fields = org.settings?.folder?.fields?.field ?? [];
    const attributes: Record<string, string> = {};
    for (const field of fields) {
      attributes[field["@attributes"].id] = field.label;
    }
    return { attributes };
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
}
