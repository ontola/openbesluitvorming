import { projectEntityCommitToQuickwitDocument } from "./project.ts";
import type { EntityCommitEvent, MeetingEntity } from "../types.ts";

const DEFAULT_INDEX_ID = "woozi-events";
const DEFAULT_QUICKWIT_URL = "http://127.0.0.1:7280";

type QuickwitSearchResponse = {
  num_hits: number;
  hits: Array<Record<string, unknown>>;
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl(): string {
  return Deno.env.get("QUICKWIT_URL") ?? DEFAULT_QUICKWIT_URL;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Quickwit request failed ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

export class QuickwitClient {
  constructor(
    private readonly baseUrl = getBaseUrl(),
    private readonly indexId = DEFAULT_INDEX_ID,
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
    const configText = await Deno.readTextFile(configPath);
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

  async ingestMeetingEvents(events: Array<EntityCommitEvent<MeetingEntity>>): Promise<void> {
    const documents = events.map(projectEntityCommitToQuickwitDocument);
    const body = documents.map((document) => JSON.stringify(document)).join("\n");

    const response = await fetch(`${this.baseUrl}/api/v1/${this.indexId}/ingest?commit=wait_for`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Quickwit ingest failed ${response.status}: ${await response.text()}`);
    }
  }

  async search(query: string, maxHits = 10): Promise<QuickwitSearchResponse> {
    return await fetchJson<QuickwitSearchResponse>(
      `${this.baseUrl}/api/v1/${this.indexId}/search`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_hits: maxHits,
        }),
      },
    );
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
