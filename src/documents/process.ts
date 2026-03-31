import type { DocumentEntity } from "../types.ts";
import { extractDocumentText } from "./text.ts";
import { ObjectStorageClient } from "../storage/s3.ts";

function sanitizedFileName(document: DocumentEntity): string {
  const candidate = document.file_name?.trim() || `${document.id}.bin`;
  return candidate.replaceAll(/[^\w.\-() ]+/g, "_");
}

function objectKey(document: DocumentEntity): string {
  const source = document.source_info.source;
  const canonicalId = document.source_info.canonical_id ?? document.id;
  return `documents/${source}/${canonicalId}/${sanitizedFileName(document)}`;
}

export async function materializeDocument(
  document: DocumentEntity,
  options: {
    download: (url: string) => Promise<Uint8Array>;
    storage?: ObjectStorageClient;
  },
): Promise<DocumentEntity> {
  if (!document.original_url) {
    return document;
  }

  const bytes = await options.download(document.original_url);
  const text = await extractDocumentText(bytes, {
    contentType: document.content_type,
    fileName: document.file_name,
  });

  let mediaUrls = document.media_urls;
  if (options.storage) {
    const stored = await options.storage.putObject(objectKey(document), bytes, {
      contentType: document.content_type,
      metadata: {
        entity_id: document.id,
        source: document.source_info.source,
      },
    });
    mediaUrls = [
      {
        url: stored.url,
        original_url: document.original_url,
        content_type: document.content_type,
      },
    ];
  }

  return {
    ...document,
    text: text ? [text] : undefined,
    media_urls: mediaUrls,
  };
}
