const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;
const FETCH_TIMEOUT_MS = 90_000;

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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

export type GoCommittee = {
  id: number | string;
  name: string;
};

export type GoDocumentRef = {
  id: number | string;
  filename?: string;
};

export type GoMeetingItem = {
  id: number | string;
  number?: string;
  title?: string;
  description?: string;
  sortorder?: number;
  documents?: GoDocumentRef[];
};

export type GoMeeting = {
  id: number | string;
  date: string;
  startTime?: string;
  description?: string;
  location?: string;
  canceled?: boolean;
  inactive?: boolean;
  dmu?: { id: number | string; name?: string };
  items?: GoMeetingItem[];
  documents?: GoDocumentRef[];
};

export class GemeenteOplossingenClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiVersion: "v1" | "v2" = "v1",
  ) {}

  private url(path: string): string {
    const base = this.baseUrl.trim();
    const trimmed = base.endsWith("/") ? base : `${base}/`;
    return `${trimmed}${this.apiVersion}/${path.replace(/^\//, "")}`;
  }

  async listCommittees(): Promise<GoCommittee[]> {
    const data = await fetchJson<unknown>(this.url("dmus"));
    return Array.isArray(data) ? (data as GoCommittee[]) : [];
  }

  async listMeetingsByDateRange(dateFrom: string, dateTo: string): Promise<GoMeeting[]> {
    const url = this.apiVersion === "v2"
      ? this.url(`meetings?date_from=${dateFrom}&date_to=${dateTo}`)
      : this.url(
        `meetings?date_from=${Math.floor(Date.parse(`${dateFrom}T00:00:00Z`) / 1000)}&date_to=${
          Math.floor(Date.parse(`${dateTo}T00:00:00Z`) / 1000)
        }`,
      );
    const data = await fetchJson<unknown>(url);
    return Array.isArray(data) ? (data as GoMeeting[]) : [];
  }
}

