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
      const response = await this.client.fetch(
        `${this.endpoint}/${this.bucket}?${params}`,
        { method: "GET" },
      );
      if (!response.ok) {
        throw new Error(await errorSummary(response));
      }
      body = await response.text();
    } catch (error) {
      throw describeStorageError("list", options.prefix ?? "", error);
    }

    const keys = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) =>
      decodeXmlEntities(match[1])
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

  async getObjectBytes(key: string): Promise<Uint8Array | null> {
    let response: Response;
    try {
      response = await this.client.fetch(this.objectUrl(key), { method: "GET" });
    } catch (error) {
      throw describeStorageError("read", key, error);
    }

    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      throw describeStorageError("read", key, new Error(await errorSummary(response)));
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}
