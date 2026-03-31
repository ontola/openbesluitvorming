import type { EntityCommitEvent, SourceInfo, WooziEntity } from "../types.ts";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

  return `{${entries.join(",")}}`;
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sourceUri(source: SourceInfo): string {
  return `/woozi/${source.supplier}/${source.source}`;
}

export async function buildEntityCommitEvent<TPayload extends WooziEntity>(
  entity: TPayload,
  options: {
    schemaVersion?: string;
    time?: string;
    parentCommitId?: string;
  } = {},
): Promise<EntityCommitEvent<TPayload>> {
  const { raw: _raw, source_info, ...payloadWithoutRaw } = entity;
  const payload = {
    ...payloadWithoutRaw,
    source_info,
  } as TPayload;

  const contentHash = `sha256:${await sha256(stableStringify(payload))}`;
  const commitId = `commit:${entity.id}:${contentHash.slice(7, 19)}`;
  const time = options.time ?? new Date().toISOString();

  return {
    specversion: "1.0",
    type: "entity.commit",
    source: sourceUri(entity.source_info),
    id: commitId,
    time,
    subject: entity.id,
    datacontenttype: "application/json",
    data: {
      entity_type: entity.type,
      entity_id: entity.id,
      commit_id: commitId,
      parent_commit_id: options.parentCommitId,
      op: "upsert",
      mode: "replace",
      schema_name: entity.type,
      schema_version: options.schemaVersion ?? "v1alpha1",
      content_hash: contentHash,
      source: entity.source_info,
      payload,
    },
  };
}
