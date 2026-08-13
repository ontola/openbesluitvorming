import type { QuickwitSearchDocument } from "./project.ts";
import { projectEntityCommitToQuickwitDocuments } from "./project.ts";
import type { EntityCommitEvent, WooziEntity } from "../types.ts";

const DEFAULT_INDEX_ID = "woozi-events";
const DEFAULT_QUICKWIT_URL = "http://127.0.0.1:7280";
const MAX_INGEST_PAYLOAD_BYTES = 8_000_000;
// commit=wait_for makes Quickwit hold the response until the batch is
// published. Without an explicit timeout the fetch can hang indefinitely if
// Quickwit's ingest pipeline stalls, blocking the whole run.
const INGEST_TIMEOUT_MS = 120_000;
const INGEST_ATTEMPTS = 8;
const INGEST_RETRY_BASE_MS = 1_000;
const INGEST_RETRY_MAX_MS = 30_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;
const DEFAULT_SEARCH_ATTEMPTS = 2;

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
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message.includes("Quickwit request failed 500") ||
    error.message.includes("No such file or directory")
  );
}

/** Whether an ingest is worth trying again.
 *
 * This used to match only "index not found". Everything else -- a timeout, a
 * dropped connection, backpressure from the indexer -- ended the run that
 * raised it, and a reindex run covers a whole source, so one transient
 * rejection threw away hours of work. That is what happened to four of 325
 * sources during the v3 reindex (2026-08-13): each died at an arbitrary point
 * on `413 The request payload is too large` while 32 ingests ran at once.
 *
 * 413 is included deliberately. Our bodies are capped at 8 MB and Quickwit
 * accepts 10 MiB -- measured, 10 MB answers, 11 MB is refused -- and the
 * largest single row in the source that failed first is 0.11 MB. So the
 * rejection was not about this request's size, and the same body sent again
 * has every chance of landing. If it genuinely were too large, the batch is
 * halved on the next attempt and shrinks until it fits or is reported.
 *
 * The same omission cost 22 of 128 sources in the Notubiz client three days
 * earlier. A narrow retry predicate is expensive in exactly the places where
 * the work is long. */
function isRetryableIngestError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }

  const message = `${error.name} ${error.message}`.toLowerCase();
  return (
    (message.includes("index `") && message.includes("` not found")) ||
    message.includes("quickwit ingest failed 404") ||
    // Backpressure and transient server-side trouble.
    message.includes("quickwit ingest failed 413") ||
    message.includes("quickwit ingest failed 429") ||
    message.includes("quickwit ingest failed 500") ||
    message.includes("quickwit ingest failed 502") ||
    message.includes("quickwit ingest failed 503") ||
    message.includes("quickwit ingest failed 504") ||
    // Transport-level failures, in Deno's wording. The list is deliberately the
    // same one the Notubiz client arrived at the hard way.
    message.includes("error sending request") ||
    message.includes("error reading a body from connection") ||
    message.includes("connection reset") ||
    message.includes("connection closed") ||
    message.includes("broken pipe") ||
    message.includes("timed out")
  );
}

/** True when the batch should be split before trying again, rather than
 * resent unchanged. */
function shouldHalveBatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Quickwit ingest failed 413");
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

function getSearchTimeoutMs(): number {
  const value = Number(Deno.env.get("QUICKWIT_SEARCH_TIMEOUT_MS") ?? DEFAULT_SEARCH_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SEARCH_TIMEOUT_MS;
}

function getSearchAttempts(): number {
  const value = Number(Deno.env.get("QUICKWIT_SEARCH_ATTEMPTS") ?? DEFAULT_SEARCH_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SEARCH_ATTEMPTS;
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
  count_all?: boolean;
  aggs?: Record<string, unknown>;
  /** Fast field to order by. Beware the direction convention, which is the
   * opposite of the usual one: a bare (or `+`-prefixed) field name sorts
   * **descending**, and a `-` prefix sorts **ascending**. Verified against
   * Quickwit 0.8.1 on both `time` and `start_date`. Documents missing the
   * field sort last in either direction. */
  sort_by?: string;
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

    for (const body of bodies) {
      await this.postIngestBody(body);
    }

    return;
  }

  /** Send one NDJSON body, retrying what is worth retrying.
   *
   * On 413 the body is halved and each half sent on its own. That covers both
   * reasons Quickwit gives that answer: momentary backpressure, where the same
   * bytes succeed shortly after, and a body that really is too big, where
   * halving converges on something that fits. A single line that cannot be
   * split any further is reported rather than silently dropped -- losing one
   * document quietly is how a search index ends up subtly wrong. */
  private async postIngestBody(body: string): Promise<void> {
    for (let attempt = 1; attempt <= INGEST_ATTEMPTS; attempt += 1) {
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
          // Read the status before the body, and never let a failed body read
          // replace it. Quickwit's rejection often arrives with the connection
          // already closing, so `response.text()` throws -- and the thrown
          // error then said "error reading a body from connection" while the
          // status that actually mattered, 413, was lost. That is why the same
          // source appeared to fail two different ways on alternate runs, and
          // why shouldHalveBatch never fired: it was looking for a number that
          // had been thrown away (2026-08-13).
          const status = response.status;
          const detail = await response.text().catch(() => "(antwoord niet leesbaar)");
          throw new Error(`Quickwit ingest failed ${status}: ${detail}`);
        }

        return;
      } catch (error) {
        const lines = body.split("\n");
        if (shouldHalveBatch(error) && lines.length > 1) {
          const middle = Math.floor(lines.length / 2);
          await this.postIngestBody(lines.slice(0, middle).join("\n"));
          await this.postIngestBody(lines.slice(middle).join("\n"));
          return;
        }
        if (attempt === INGEST_ATTEMPTS || !isRetryableIngestError(error)) {
          throw error;
        }
        // Exponential, because the thing being waited out is a queue draining,
        // not a blip. Quickwit publishes a split roughly every two seconds
        // during a bulk reindex and its ingest queue had 90 MB of backlog when
        // it started refusing; 500ms steps totalling seven seconds gave up
        // while it was still catching up, and took a whole source down with
        // them. This tops out around two minutes.
        await sleep(Math.min(INGEST_RETRY_BASE_MS * 2 ** (attempt - 1), INGEST_RETRY_MAX_MS));
      }
    }
  }

  /** Creates a Quickwit delete task (delete-by-query). Deletes are applied
   * asynchronously by the janitor during merges — matching documents keep
   * showing up in searches until then, so callers that need immediate
   * invisibility must also ingest a newer op:"delete" marker document. */
  async createDeleteTask(query: string): Promise<void> {
    await fetchJson(`${this.baseUrl}/api/v1/${this.indexId}/delete-tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
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
    const attempts = getSearchAttempts();
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetchJson<QuickwitSearchResponse>(
          `${this.baseUrl}/api/v1/${this.indexId}/search`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            signal: AbortSignal.timeout(getSearchTimeoutMs()),
            body: JSON.stringify(body),
          },
        );
      } catch (error) {
        lastError = error;
        if (attempt === attempts || !isRetryableSearchError(error)) {
          throw error;
        }
        await sleep(100 * attempt);
      }
    }

    throw lastError;
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

export const __test__ = { isRetryableIngestError, shouldHalveBatch };
