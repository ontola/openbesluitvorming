const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;
const FETCH_TIMEOUT_MS = 30_000;

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
    return new Error(`Request transport failed for ${url}: ${summary}`);
  }

  return new Error(`Request transport failed for ${url}: ${String(error)}`);
}

type ParlaeusEnvelope<T> = {
  status?: number;
  message?: string;
} & T;

async function fetchJson<T>(url: string): Promise<ParlaeusEnvelope<T>> {
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

      const body = (await response.json()) as ParlaeusEnvelope<T>;
      // Parlaeus reports its own status code in the JSON body. HTTP 200 with
      // status !== 200 still means the call failed (e.g. unknown function,
      // invalid session id).
      if (typeof body.status === "number" && body.status !== 200) {
        throw new Error(
          `Parlaeus error ${body.status}${body.message ? `: ${body.message}` : ""} for ${url}`,
        );
      }

      return body;
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

export type ParlaeusAgendaSummary = {
  agid: string;
  date?: string;
  time?: string;
  last_change?: number;
};

export type ParlaeusDocumentRef = {
  dcid: string;
  link?: string;
  title?: string;
  number?: string;
  type?: string;
};

export type ParlaeusAgendaPoint = {
  apid: string;
  number?: string;
  title?: string;
  text?: string;
  type?: string;
  level?: number;
  decision?: string;
  documents?: ParlaeusDocumentRef[];
};

export type ParlaeusAgendaDetail = {
  agid: string;
  cmid?: string;
  committeecode?: string;
  title?: string;
  description?: string;
  location?: string;
  chairman?: string;
  secretary?: string;
  date?: string;
  time?: string;
  endtime?: string;
  cancelled?: number;
  points?: ParlaeusAgendaPoint[];
};

export type ParlaeusCommittee = {
  cmid: string;
  committeename?: string;
  committeecode?: string;
  last_change?: number;
};

export type ParlaeusPerson = {
  raid: string;
  name?: string;
  function?: string;
  party?: string;
};

function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

export class ParlaeusClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
  ) {}

  private url(fn: string, params: Record<string, string> = {}): string {
    const search = new URLSearchParams({ rid: this.sessionId, fn, ...params });
    const trimmed = this.baseUrl.endsWith("?") ? this.baseUrl : `${this.baseUrl}?`;
    return `${trimmed}${search.toString()}`;
  }

  async listAgendaSummaries(dateFrom: string, dateTo: string): Promise<ParlaeusAgendaSummary[]> {
    const data = await fetchJson<{ list?: ParlaeusAgendaSummary[] }>(
      this.url("agenda_list", {
        since: compactDate(dateFrom),
        until: compactDate(dateTo),
      }),
    );
    return Array.isArray(data.list) ? data.list : [];
  }

  async getAgendaDetail(agid: string): Promise<{ detail: ParlaeusAgendaDetail; url: string }> {
    const url = this.url("agenda_detail", { agid });
    const data = await fetchJson<{ agenda?: ParlaeusAgendaDetail }>(url);
    if (!data.agenda) {
      throw new Error(`Parlaeus agenda_detail response is missing "agenda" for ${url}`);
    }
    return { detail: data.agenda, url };
  }

  async listCommittees(): Promise<ParlaeusCommittee[]> {
    const data = await fetchJson<{ list?: ParlaeusCommittee[] }>(this.url("cie_list"));
    return Array.isArray(data.list) ? data.list : [];
  }

  async listPersons(): Promise<ParlaeusPerson[]> {
    const data = await fetchJson<{ list?: ParlaeusPerson[] }>(this.url("person_list"));
    return Array.isArray(data.list) ? data.list : [];
  }
}
