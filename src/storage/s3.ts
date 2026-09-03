// S3-compatible object storage over native fetch (SigV4 via aws4fetch).
//
// This deliberately does NOT use @aws-sdk/client-s3: under Deno's node-compat
// layer the SDK's HTTP client never releases sockets once the server closes
// its side — one CLOSE-WAIT fd per S3 request, ~250/min during cache-heavy
// ingest, until outgoing connections start failing with AggregateError
// (July 2026 incident; keepAlive:false didn't help, the leak is in the
// compat socket close handling itself). Deno's native fetch pool handles
// server-side closes correctly.

import { AwsClient } from "npm:aws4fetch";

/** Per-attempt ceiling on an object read; see getObjectBytes. */
const READ_TIMEOUT_MS = Number(Deno.env.get("WOOZI_S3_READ_TIMEOUT_MS") ?? "15000");
/** Attempts per read, with exponential back-off between them: 1s, 2s, 4s,
 * 8s, 16s -- about half a minute in total before a read is given up. Object
 * storage answers a burst it dislikes with `503 SlowDown: Please reduce your
 * request rate`; measured 2026-09-03 during the v4 reindex, 24,800 reads in a
 * few hours were refused that way and skipped, because three attempts half a
 * second apart are three chances to hit the same throttle. A throttle wants
 * patience, not persistence. `Retry-After`, when the server sends one, wins. */
const READ_ATTEMPTS = 6;
const READ_RETRY_BASE_MS = 1_000;
const READ_RETRY_MAX_MS = 16_000;

function readRetryDelayMs(attempt: number, retryAfter: string | null): number {
  const advised = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(advised) && advised > 0) {
    return Math.min(advised * 1000, 60_000);
  }
  const exponential = Math.min(READ_RETRY_MAX_MS, READ_RETRY_BASE_MS * 2 ** (attempt - 1));
  return exponential + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import { getConfigValue } from "../config.ts";

const DEFAULT_BUCKET = "woozi";
const DEFAULT_ENDPOINT = "http://127.0.0.1:9000";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_ACCESS_KEY = "woozi";
const DEFAULT_SECRET_KEY = "woozi-dev-secret";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultPublicEndpoint(endpoint: string): string {
  if (endpoint === "http://minio:9000") {
    return "http://127.0.0.1:9000";
  }
  return endpoint;
}

function describeStorageError(action: string, key: string, error: unknown): Error {
  if (error instanceof Error) {
    const name = error.name?.trim() || "Error";
    const message = error.message?.trim();
    const summary = message && message !== name ? `${name}: ${message}` : name;
    return new Error(`S3 ${action} failed for ${key}: ${summary}`, {
      cause: message && message !== name ? `${name}: ${message}` : name,
    });
  }

  return new Error(`S3 ${action} failed for ${key}: ${String(error)}`);
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

async function errorSummary(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const code = body.match(/<Code>([^<]*)<\/Code>/)?.[1];
  const message = body.match(/<Message>([^<]*)<\/Message>/)?.[1];
  const detail = [code, message].filter(Boolean).join(": ");
  return `HTTP ${response.status}${detail ? ` (${detail})` : ""}`;
}

export interface StoredObject {
  bucket: string;
  key: string;
  url: string;
}

export class ObjectStorageClient {
  private constructor(
    private readonly client: AwsClient,
    private readonly bucket: string,
    private readonly endpoint: string,
  ) {}

  static async fromEnvironment(): Promise<ObjectStorageClient> {
    const bucket = await getConfigValue("S3_STORAGE_BUCKET_NAME", DEFAULT_BUCKET);
    const endpoint = await getConfigValue("S3_STORAGE_ENDPOINT", DEFAULT_ENDPOINT);
    const region = await getConfigValue("S3_STORAGE_REGION", DEFAULT_REGION);
    const accessKeyId = await getConfigValue("S3_ACCESS_KEY", DEFAULT_ACCESS_KEY);
    const secretAccessKey = await getConfigValue("S3_SECRET_KEY", DEFAULT_SECRET_KEY);

    return new ObjectStorageClient(
      new AwsClient({
        accessKeyId,
        secretAccessKey,
        region,
        service: "s3",
        retries: 3,
      }),
      bucket,
      trimTrailingSlash(endpoint),
    );
  }

  private objectUrl(key: string): string {
    return `${this.endpoint}/${this.bucket}/${encodeKeyPath(key)}`;
  }

  async putObject(
    key: string,
    body: Uint8Array,
    options: {
      contentType?: string;
      metadata?: Record<string, string>;
    } = {},
  ): Promise<StoredObject> {
    try {
      const headers: Record<string, string> = {};
      if (options.contentType) {
        headers["content-type"] = options.contentType;
      }
      for (const [name, value] of Object.entries(options.metadata ?? {})) {
        headers[`x-amz-meta-${name.toLowerCase()}`] = value;
      }
      const response = await this.client.fetch(this.objectUrl(key), {
        method: "PUT",
        headers,
        // aws4fetch's BodyInit typing predates Uint8Array<ArrayBufferLike>.
        body: body as unknown as BodyInit,
      });
      if (!response.ok) {
        throw new Error(await errorSummary(response));
      }
      await response.body?.cancel();
    } catch (error) {
      throw describeStorageError("write", key, error);
    }

    return {
      bucket: this.bucket,
      key,
      url: this.urlForKey(key),
    };
  }

  /** Uploads a file of any size without buffering it in memory: S3 multipart
   * upload, one part in RAM at a time. Buffered putObject OOM-killed the
   * nightly backup once woozi-export-log.sqlite3 passed a few GB (July 2026:
   * exit 137 every night, stale-backup alerts). Files at or below the part
   * size go up as a plain single PUT. */
  async putObjectFromFile(
    key: string,
    filePath: string,
    options: { contentType?: string; partSizeBytes?: number } = {},
  ): Promise<StoredObject> {
    const partSize = options.partSizeBytes ?? 64 * 1024 * 1024;
    const { size } = await Deno.stat(filePath);
    if (size <= partSize) {
      return await this.putObject(key, await Deno.readFile(filePath), {
        contentType: options.contentType,
      });
    }

    const url = this.objectUrl(key);
    let uploadId = "";
    try {
      const createResponse = await this.client.fetch(`${url}?uploads`, {
        method: "POST",
        headers: options.contentType ? { "content-type": options.contentType } : {},
      });
      if (!createResponse.ok) {
        throw new Error(await errorSummary(createResponse));
      }
      const createBody = await createResponse.text();
      uploadId = createBody.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1] ?? "";
      if (!uploadId) {
        throw new Error("multipart create returned no UploadId");
      }

      const file = await Deno.open(filePath, { read: true });
      const etags: string[] = [];
      try {
        const buffer = new Uint8Array(partSize);
        for (let partNumber = 1; ; partNumber += 1) {
          let filled = 0;
          while (filled < partSize) {
            const read = await file.read(buffer.subarray(filled));
            if (read === null) {
              break;
            }
            filled += read;
          }
          if (filled === 0) {
            break;
          }
          const partResponse = await this.client.fetch(
            `${url}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
            { method: "PUT", body: buffer.slice(0, filled) as unknown as BodyInit },
          );
          if (!partResponse.ok) {
            throw new Error(`part ${partNumber}: ${await errorSummary(partResponse)}`);
          }
          await partResponse.body?.cancel();
          const etag = partResponse.headers.get("etag");
          if (!etag) {
            throw new Error(`part ${partNumber} returned no ETag`);
          }
          etags.push(etag);
          if (filled < partSize) {
            break;
          }
        }
      } finally {
        file.close();
      }

      const completeXml = `<CompleteMultipartUpload>${etags
        .map(
          (etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
        )
        .join("")}</CompleteMultipartUpload>`;
      const completeResponse = await this.client.fetch(
        `${url}?uploadId=${encodeURIComponent(uploadId)}`,
        { method: "POST", headers: { "content-type": "application/xml" }, body: completeXml },
      );
      const completeBody = await completeResponse.text();
      // S3 can return 200 with an <Error> body for a failed complete.
      if (!completeResponse.ok || completeBody.includes("<Error>")) {
        throw new Error(
          `multipart complete failed: HTTP ${completeResponse.status} ${completeBody.slice(0, 200)}`,
        );
      }
    } catch (error) {
      if (uploadId) {
        await this.client
          .fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" })
          .then((response) => response.body?.cancel())
          .catch(() => undefined);
      }
      throw describeStorageError("multipart write", key, error);
    }

    return {
      bucket: this.bucket,
      key,
      url: this.urlForKey(key),
    };
  }

  urlForKey(key: string): string {
    return `${this.endpoint}/${this.bucket}/${key}`;
  }

  static async publicUrlForKey(key: string): Promise<string> {
    const bucket = await getConfigValue("S3_STORAGE_BUCKET_NAME", DEFAULT_BUCKET);
    const storageEndpoint = await getConfigValue("S3_STORAGE_ENDPOINT", DEFAULT_ENDPOINT);
    const endpoint = await getConfigValue(
      "S3_PUBLIC_ENDPOINT",
      defaultPublicEndpoint(storageEndpoint),
    );
    return `${trimTrailingSlash(endpoint)}/${bucket}/${key}`;
  }

  async hasObject(key: string): Promise<boolean> {
    try {
      const response = await this.client.fetch(this.objectUrl(key), { method: "HEAD" });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  async getObjectText(key: string): Promise<string> {
    const bytes = await this.getObjectBytes(key);
    if (!bytes) {
      return "";
    }

    return new TextDecoder().decode(bytes);
  }

  async listObjects(
    options: {
      prefix?: string;
      startAfter?: string;
      maxKeys?: number;
    } = {},
  ): Promise<{ keys: string[]; isTruncated: boolean }> {
    const params = new URLSearchParams({ "list-type": "2" });
    if (options.prefix) {
      params.set("prefix", options.prefix);
    }
    if (options.startAfter) {
      params.set("start-after", options.startAfter);
    }
    if (options.maxKeys) {
      params.set("max-keys", `${options.maxKeys}`);
    }

    let body: string;
    try {
      const response = await this.client.fetch(`${this.endpoint}/${this.bucket}?${params}`, {
        method: "GET",
      });
      if (!response.ok) {
        throw new Error(await errorSummary(response));
      }
      body = await response.text();
    } catch (error) {
      throw describeStorageError("list", options.prefix ?? "", error);
    }

    const keys = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) =>
      decodeXmlEntities(match[1]),
    );
    return {
      keys,
      isTruncated: /<IsTruncated>true<\/IsTruncated>/.test(body),
    };
  }

  async deleteObjects(keys: string[]): Promise<void> {
    // Per-key DELETE instead of the Multi-Object Delete API: our delete
    // volumes are tiny (takedowns, test cleanup) and the batch API requires
    // a Content-MD5 header, which WebCrypto cannot produce.
    for (const key of keys) {
      try {
        const response = await this.client.fetch(this.objectUrl(key), { method: "DELETE" });
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        throw describeStorageError("delete", key, error);
      }
    }
  }

  /** Deletes every object under the prefix. Returns the deleted keys. */
  async deleteByPrefix(prefix: string): Promise<string[]> {
    if (!prefix || prefix === "/") {
      throw new Error(`Refusing to delete by empty prefix`);
    }
    const deleted: string[] = [];
    let startAfter: string | undefined;
    while (true) {
      const { keys, isTruncated } = await this.listObjects({ prefix, startAfter });
      if (keys.length === 0) {
        break;
      }
      await this.deleteObjects(keys);
      deleted.push(...keys);
      if (!isTruncated) {
        break;
      }
      startAfter = keys[keys.length - 1];
    }
    return deleted;
  }

  /** Read one object, with a ceiling on how long a single attempt may take.
   *
   * Object storage answers most reads in tens of milliseconds and a few in
   * tens of seconds: measured 2026-09-03 on Hetzner, 2-4% of GETs took 6-60s
   * regardless of size, and some came back 504 after exactly 60s -- three
   * times in a row through aws4fetch's own retry loop, which has no timeout.
   * One such object then held a reindex slice for three minutes. So the
   * attempts are made here, each under an abort signal, and aws4fetch is only
   * asked to sign. Retried: a timeout, a network error, 429, and 5xx. Not
   * retried: 404 (absent is an answer) and other 4xx. */
  async getObjectBytes(key: string): Promise<Uint8Array | null> {
    const url = this.objectUrl(key);
    let lastError: unknown;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        const signed = await this.client.sign(url, { method: "GET" });
        response = await fetch(signed, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      } catch (error) {
        lastError = error;
        if (attempt < READ_ATTEMPTS) {
          await sleep(readRetryDelayMs(attempt, null));
          continue;
        }
        throw describeStorageError("read", key, error);
      }

      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get("retry-after");
        lastError = new Error(await errorSummary(response));
        if (attempt < READ_ATTEMPTS) {
          await sleep(readRetryDelayMs(attempt, retryAfter));
          continue;
        }
        throw describeStorageError("read", key, lastError);
      }
      if (!response.ok) {
        throw describeStorageError("read", key, new Error(await errorSummary(response)));
      }

      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        // The body can stall after the headers arrived; the signal covers it.
        lastError = error;
        if (attempt < READ_ATTEMPTS) {
          await sleep(readRetryDelayMs(attempt, null));
          continue;
        }
        throw describeStorageError("read", key, error);
      }
    }
    throw describeStorageError("read", key, lastError);
  }
}
