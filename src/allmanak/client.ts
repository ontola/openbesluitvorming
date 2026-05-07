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

export type AllmanakPartySeat = {
  partij?: string;
  naam?: string;
};

export type AllmanakOverheidsorganisatiePartiesResponse = Array<{
  zetels?: AllmanakPartySeat[];
}>;

export type AllmanakCouncilMember = {
  systemid: string | number;
  naam: string;
  partij?: string;
};

export type AllmanakOverheidsorganisatiePersonsResponse = Array<{
  naam?: string;
  functies?: Array<{
    functie?: {
      naam?: string;
      medewerkers?: Array<{
        persoon?: AllmanakCouncilMember;
      }>;
    };
  }>;
}>;

export class AllmanakClient {
  constructor(private readonly apiVersion = "v1") {}

  private baseUrl(): string {
    return `https://rest-api.allmanak.nl/${this.apiVersion}/`;
  }

  async getCouncilParties(allmanakId: number): Promise<AllmanakPartySeat[]> {
    const url =
      `${this.baseUrl()}overheidsorganisatie?systemid=eq.${allmanakId}&select=zetels`;
    const response = await fetchJson<AllmanakOverheidsorganisatiePartiesResponse>(url);
    const seats = response?.[0]?.zetels;
    return Array.isArray(seats) ? seats : [];
  }

  async getCouncilMembers(allmanakId: number): Promise<AllmanakCouncilMember[]> {
    const url =
      `${this.baseUrl()}overheidsorganisatie?systemid=eq.${allmanakId}` +
      `&select=naam,functies(functie:functieid(naam,medewerkers(persoon:persoonid(systemid,naam,partij))))` +
      `&functies.functie.naam=eq.Raadslid`;
    const response = await fetchJson<AllmanakOverheidsorganisatiePersonsResponse>(url);
    const functies = response?.[0]?.functies;
    if (!Array.isArray(functies)) {
      return [];
    }

    const persons: AllmanakCouncilMember[] = [];
    for (const row of functies) {
      const medewerkers = row?.functie?.medewerkers;
      if (!Array.isArray(medewerkers)) {
        continue;
      }
      for (const record of medewerkers) {
        const person = record?.persoon;
        if (person && typeof person === "object" && typeof person.naam === "string") {
          persons.push(person);
        }
      }
    }

    return persons;
  }
}

