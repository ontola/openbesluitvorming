import type { DocumentEntity, ExtractionIssue } from "../types.ts";
import { extractDocumentMarkdown } from "./text.ts";

interface CachedStorage {
  hasObject(key: string): Promise<boolean>;
  putObject(
    key: string,
    body: Uint8Array,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<{ url: string }>;
  getObjectText(key: string): Promise<string>;
  urlForKey(key: string): string;
}

export interface MaterializedDocumentResult {
  document: DocumentEntity;
  cacheHit: boolean;
  issues: ExtractionIssue[];
}

function sanitizedFileName(document: DocumentEntity): string {
  const candidate = document.file_name?.trim() || `${document.id}.bin`;
  return candidate.replaceAll(/[^\w.\-() ]+/g, "_");
}

function objectKey(document: DocumentEntity): string {
  const version = cacheVersionToken(document);
  const source = document.source_info.source;
  const canonicalId = document.source_info.canonical_id ?? document.id;
  return `documents/${source}/${canonicalId}/${version}/${sanitizedFileName(document)}`;
}

function extractedMarkdownKey(document: DocumentEntity): string {
  return `${objectKey(document)}.md`;
}

function sanitizeToken(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "_");
}

function cacheVersionToken(document: DocumentEntity): string {
  const raw =
    document.raw && typeof document.raw === "object"
      ? (document.raw as Record<string, unknown>)
      : {};
  // This token currently depends on Notubiz metadata fields on the raw document payload.
  // Other suppliers should provide an equivalent stable version/checksum signal here.
  const version =
    typeof raw.version === "number" || typeof raw.version === "string" ? String(raw.version) : "v0";
  const lastModified =
    typeof raw.last_modified === "string"
      ? sanitizeToken(raw.last_modified.replace(" ", "T"))
      : document.date_modified
        ? sanitizeToken(document.date_modified)
        : "unknown";
  return `${version}-${lastModified}`;
}

async function readCachedDocument(
  document: DocumentEntity,
  storage: CachedStorage,
): Promise<MaterializedDocumentResult | null> {
  const fileKey = objectKey(document);
  const markdownKey = extractedMarkdownKey(document);
  // We only reuse cache when both the stored source file and the derived markdown sidecar exist
  // for the same supplier-specific version token.
  const hasFile = await storage.hasObject(fileKey);
  const hasMarkdown = await storage.hasObject(markdownKey);

  if (!hasFile || !hasMarkdown) {
    return null;
  }

  const mdText = await storage.getObjectText(markdownKey);
  return {
    cacheHit: true,
    issues: [],
    document: {
      ...document,
      md_text: mdText ? [mdText] : undefined,
      derived_content: {
        markdown_key: markdownKey,
      },
      media_urls: [
        {
          url: storage.urlForKey(fileKey),
          original_url: document.original_url,
          content_type: document.content_type,
        },
      ],
    },
  };
}

export async function materializeDocument(
  document: DocumentEntity,
  options: {
    download: (url: string) => Promise<Uint8Array>;
    storage?: CachedStorage;
  },
): Promise<MaterializedDocumentResult> {
  if (!document.original_url) {
    return { document, cacheHit: false, issues: [] };
  }

  if (options.storage) {
    const cached = await readCachedDocument(document, options.storage);
    if (cached) {
      return cached;
    }
  }

  const bytes = await options.download(document.original_url);
  const extraction = await extractDocumentMarkdown(bytes, {
    contentType: document.content_type,
    fileName: document.file_name,
  });
  const mdText = extraction.markdown;
  const issues = extraction.warnings.map((message) => ({
    severity: "warning" as const,
    step: "extract_text" as const,
    entity_id: document.id,
    message,
  }));

  let mediaUrls = document.media_urls;
  if (options.storage) {
    const stored = await options.storage.putObject(objectKey(document), bytes, {
      contentType: document.content_type,
      metadata: {
        entity_id: document.id,
        source: document.source_info.source,
      },
    });
    await options.storage.putObject(
      extractedMarkdownKey(document),
      new TextEncoder().encode(mdText),
      {
        contentType: "text/markdown; charset=utf-8",
        metadata: {
          entity_id: document.id,
          source: document.source_info.source,
          kind: "markdown_text",
        },
      },
    );
    mediaUrls = [
      {
        url: stored.url,
        original_url: document.original_url,
        content_type: document.content_type,
      },
    ];
  }

  return {
    cacheHit: false,
    issues,
    document: {
      ...document,
      md_text: mdText ? [mdText] : undefined,
      derived_content: options.storage
        ? {
            markdown_key: extractedMarkdownKey(document),
          }
        : undefined,
      media_urls: mediaUrls,
    },
  };
}
