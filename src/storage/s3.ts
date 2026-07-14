import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3";
import { NodeHttpHandler } from "npm:@smithy/node-http-handler";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
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

export interface StoredObject {
  bucket: string;
  key: string;
  url: string;
}

export class ObjectStorageClient {
  private constructor(
    private readonly client: S3Client,
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
      new S3Client({
        region,
        endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
        // No keep-alive: under Deno's node-compat layer, pooled sockets that
        // the S3 server closes on its side are never released and pile up in
        // CLOSE-WAIT at the S3 request rate (~250 fds/min during cache-heavy
        // ingest; 8k+ leaked sockets eventually break all outgoing
        // connections with AggregateError — July 2026 incident). A handshake
        // per request costs ~ms at our request rates.
        requestHandler: new NodeHttpHandler({
          httpAgent: new HttpAgent({ keepAlive: false }),
          httpsAgent: new HttpsAgent({ keepAlive: false }),
        }),
      }),
      bucket,
      trimTrailingSlash(endpoint),
    );
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
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          Metadata: options.metadata,
        }),
      );
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
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
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
    let response;
    try {
      response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: options.prefix,
          StartAfter: options.startAfter,
          MaxKeys: options.maxKeys,
        }),
      );
    } catch (error) {
      throw describeStorageError("list", options.prefix ?? "", error);
    }

    return {
      keys: (response.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key)),
      isTruncated: response.IsTruncated ?? false,
    };
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const batch = keys.slice(offset, offset + 1000);
      try {
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: batch.map((key) => ({ Key: key })),
              Quiet: true,
            },
          }),
        );
        const errors = response.Errors ?? [];
        if (errors.length > 0) {
          const first = errors[0];
          throw new Error(
            `${errors.length} objects failed, first: ${first.Key} (${first.Code}: ${first.Message})`,
          );
        }
      } catch (error) {
        throw describeStorageError("delete", batch[0] ?? "", error);
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
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "NoSuchKey" || error.name === "NotFound" || error.name === "NoSuchBucket")
      ) {
        return null;
      }
      throw describeStorageError("read", key, error);
    }

    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      return null;
    }

    return bytes;
  }
}
