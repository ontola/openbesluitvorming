import type { QuickwitSearchDocument } from "./project.ts";
import { projectEntityCommitToQuickwitDocuments } from "./project.ts";
import type { EntityCommitEvent, WooziEntity } from "../types.ts";

const DEFAULT_INDEX_ID = "woozi-events";
const DEFAULT_QUICKWIT_URL = "http://127.0.0.1:7280";
const MAX_INGEST_PAYLOAD_BYTES = 8_000_000;

type QuickwitSearchResponse = {
  num_hits: number;
  hits: Array<Record<string, unknown>>;
  snippets?: Array<Record<string, string[]>>;
  aggregations?: Record<string, unknown>;
};

function isRetryableSearchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Quickwit request failed 500") ||
    error.message.includes("No such file or directory")
  );
}

function isRetryableIngestError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("index `") && error.message.includes("` not found") ||
    error.message.includes("Quickwit ingest failed 404")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl(): string {
  return Deno.env.get("QUICKWIT_URL") ?? DEFAULT_QUICKWIT_URL;
}

function getIndexId(): string {
  return Deno.env.get("QUICKWIT_INDEX_ID") ?? DEFAULT_INDEX_ID;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Quickwit request failed ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

type QuickwitSearchRequest = {
  query: string;
  max_hits?: number;
  start_offset?: number;
  snippet_fields?: string;
  aggs?: Record<string, unknown>;
};

export class QuickwitClient {
  constructor(
    private readonly baseUrl = getBaseUrl(),
    private readonly indexId = getIndexId(),
  ) {}

  async waitUntilReady(timeoutMs = 20000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(`${this.baseUrl}/api/v1/indexes`);
        if (response.ok) {
          return;
        }
      } catch {
        // ignore until timeout
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Quickwit did not become ready in time");
  }

  async ensureIndex(configPath: string): Promise<void> {
    const config = JSON.parse(await Deno.readTextFile(configPath)) as Record<string, unknown>;
    config.index_id = this.indexId;
    const configText = JSON.stringify(config);
    const list = await fetchJson<
      Array<{ index_id?: string; index_config?: { index_id?: string } }>
    >(`${this.baseUrl}/api/v1/indexes`);
    if (
      list.some(
        (item) => item.index_id === this.indexId || item.index_config?.index_id === this.indexId,
      )
    ) {
      return;
    }

    await fetchJson(`${this.baseUrl}/api/v1/indexes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: configText,
    });
  }

  async ingestEvents(events: Array<EntityCommitEvent<WooziEntity>>): Promise<void> {
    const documents = events.flatMap(projectEntityCommitToQuickwitDocuments);
    await this.ingestDocuments(documents);
  }

  async ingestDocuments(documents: QuickwitSearchDocument[]): Promise<void> {
    const bodies: string[] = [];
    let currentLines: string[] = [];
    let currentBytes = 0;

    for (const document of documents) {
      const line = JSON.stringify(document);
      const lineBytes = new TextEncoder().encode(`${line}\n`).byteLength;

      if (currentLines.length > 0 && currentBytes + lineBytes > MAX_INGEST_PAYLOAD_BYTES) {
        bodies.push(currentLines.join("\n"));
        currentLines = [];
        currentBytes = 0;
      }

      currentLines.push(line);
      currentBytes += lineBytes;
    }

    if (currentLines.length > 0) {
      bodies.push(currentLines.join("\n"));
    }

    // commit=wait_for makes Quickwit hold the response until the batch is
    // published. Without an explicit timeout the fetch can hang indefinitely
    // if Quickwit's ingest pipeline stalls, blocking the whole run.
    const INGEST_TIMEOUT_MS = 120_000;

    for (const body of bodies) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          const response = await fetch(
            `${this.baseUrl}/api/v1/${this.indexId}/ingest?commit=wait_for`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
              body,
            },
          );

          if (!response.ok) {
            throw new Error(`Quickwit ingest failed ${response.status}: ${await response.text()}`);
          }

          break;
        } catch (error) {
          if (attempt === 5 || !isRetryableIngestError(error)) {
            throw error;
          }
          await sleep(500 * attempt);
        }
      }
    }

    return;
  }

  async search(
    query: string,
    maxHits = 10,
    options: {
      snippetFields?: string[];
    } = {},
  ): Promise<QuickwitSearchResponse> {
    const { snippetFields = [] } = options;

    return await this.searchRequest({
      query,
      max_hits: maxHits,
      ...(snippetFields.length > 0 ? { snippet_fields: snippetFields.join(",") } : {}),
    });
  }

  async searchRequest(body: QuickwitSearchRequest): Promise<QuickwitSearchResponse> {
    return await fetchJson<QuickwitSearchResponse>(`${this.baseUrl}/api/v1/${this.indexId}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async searchEventually(
    query: string,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      minHits?: number;
    } = {},
  ): Promise<QuickwitSearchResponse> {
    const { timeoutMs = 10000, pollIntervalMs = 500, minHits = 1 } = options;
    const startedAt = Date.now();
    let lastError: unknown;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        const result = await this.search(query);
        if (result.num_hits >= minHits) {
          return result;
        }
      } catch (error) {
        if (!isRetryableSearchError(error)) {
          throw error;
        }
        lastError = error;
      }

      await sleep(pollIntervalMs);
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error(`Quickwit search did not return ${minHits} hit(s) in time for query: ${query}`);
  }
}
