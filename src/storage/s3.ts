import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3";
import { getConfigValue } from "../config.ts";

const DEFAULT_BUCKET = "woozi";
const DEFAULT_ENDPOINT = "http://127.0.0.1:9000";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_ACCESS_KEY = "woozi";
const DEFAULT_SECRET_KEY = "woozi-dev-secret";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
