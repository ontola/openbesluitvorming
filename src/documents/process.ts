import type { DocumentEntity, ExtractionIssue } from "../types.ts";
import { extractDocumentMarkdown } from "./text.ts";
import type { IngestExecutionMode } from "../types.ts";
import { assessMarkdownQuality } from "./quality.ts";
import { currentDerivationVersion } from "../pipeline/versioning.ts";

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
  getObjectBytes(key: string): Promise<Uint8Array | null>;
  urlForKey(key: string): string;
}

type StoredPageChunks = {
  pages: Array<{
    page_number: number;
    markdown: string;
  }>;
};

export interface MaterializedDocumentResult {
  document: DocumentEntity;
  cacheHit: boolean;
  issues: ExtractionIssue[];
}

function documentIssueContext(document: DocumentEntity): string {
  const parts = [document.file_name?.trim(), document.original_url?.trim()].filter(
    (value): value is string => Boolean(value),
  );

  return parts.length > 0 ? parts.join(" | ") : document.id;
}

function issueDetailsFromError(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  return typeof error.cause === "string" && error.cause.trim() ? error.cause : undefined;
}

function sanitizedFileName(document: DocumentEntity): string {
  const candidate = document.file_name?.trim() || `${document.id}.bin`;
  return candidate.replaceAll(/[^\w.\-() ]+/g, "_");
}

function objectKey(document: DocumentEntity): string {
  const version = cacheVersionToken(document);
  const supplier = document.source_info.supplier;
  const organizationType = document.source_info.organization_type ?? "onbekend";
  const source = document.source_info.source;
  const canonicalId = document.source_info.canonical_id ?? document.id;
  return `documents/${supplier}/${organizationType}/${source}/${canonicalId}/${version}/${sanitizedFileName(document)}`;
}

function extractedMarkdownKey(document: DocumentEntity): string {
  return `${objectKey(document)}.${currentDerivationVersion()}.md`;
}

function extractedPageChunksKey(document: DocumentEntity): string {
  return `${objectKey(document)}.${currentDerivationVersion()}.pages.json`;
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
  const pageChunksKey = extractedPageChunksKey(document);
  // We only reuse cache when both the stored source file and the derived markdown sidecar exist
  // for the same supplier-specific version token.
  const hasFile = await storage.hasObject(fileKey);
  const hasMarkdown = await storage.hasObject(markdownKey);
  const hasPageChunks = await storage.hasObject(pageChunksKey);

  if (!hasFile || !hasMarkdown) {
    return null;
  }

  const mdText = await storage.getObjectText(markdownKey);
  const pageChunksText = hasPageChunks ? await storage.getObjectText(pageChunksKey) : "";
  const pageChunks = pageChunksText
    ? ((JSON.parse(pageChunksText) as StoredPageChunks).pages ?? [])
    : [];
  const quality = mdText ? assessMarkdownQuality(mdText) : null;
  return {
    cacheHit: true,
    issues: [],
    document: {
      ...document,
      md_text: mdText ? [mdText] : undefined,
      page_chunks: pageChunks,
      derived_content: {
        markdown_key: markdownKey,
        page_chunks_key: hasPageChunks ? pageChunksKey : undefined,
        page_count: pageChunks.length > 0 ? pageChunks.length : undefined,
        extraction_quality_score: quality?.score,
        extraction_quality_status: quality?.status,
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

async function rederiveFromStoredFile(
  document: DocumentEntity,
  storage: CachedStorage,
): Promise<MaterializedDocumentResult | null> {
  const fileKey = objectKey(document);
  let storedBytes: Uint8Array | null;
  try {
    storedBytes = await storage.getObjectBytes(fileKey);
  } catch {
    return null;
  }
  if (!storedBytes) {
    return null;
  }

  let mdText = "";
  let pageChunks = document.page_chunks ?? [];
  const issues: ExtractionIssue[] = [];

  try {
    const extraction = await extractDocumentMarkdown(storedBytes, {
      contentType: document.content_type,
      fileName: document.file_name,
    });
    mdText = extraction.markdown;
    pageChunks = extraction.pageChunks ?? [];
    issues.push(
      ...extraction.warnings.map((message) => ({
        severity: "warning" as const,
        step: "extract_text" as const,
        entity_id: document.id,
        message,
      })),
    );
  } catch (error) {
    issues.push({
      severity: "error",
      step: "extract_text",
      entity_id: document.id,
      message: `${documentIssueContext(document)}: ${error instanceof Error ? error.message : "Document extraction failed"}`,
      details: issueDetailsFromError(error),
    });
  }

  if (mdText) {
    await storage.putObject(extractedMarkdownKey(document), new TextEncoder().encode(mdText), {
      contentType: "text/markdown; charset=utf-8",
      metadata: {
        entity_id: document.id,
        source: document.source_info.source,
        kind: "markdown_text",
      },
    });
  }

  if (pageChunks.length > 0) {
    await storage.putObject(
      extractedPageChunksKey(document),
      new TextEncoder().encode(JSON.stringify({ pages: pageChunks })),
      {
        contentType: "application/json; charset=utf-8",
        metadata: {
          entity_id: document.id,
          source: document.source_info.source,
          kind: "pdf_page_chunks",
        },
      },
    );
  }

  const quality = mdText ? assessMarkdownQuality(mdText) : null;

  return {
    cacheHit: true,
    issues,
    document: {
      ...document,
      derived_content: {
        markdown_key: mdText ? extractedMarkdownKey(document) : undefined,
        page_chunks_key: pageChunks.length > 0 ? extractedPageChunksKey(document) : undefined,
        page_count: pageChunks.length > 0 ? pageChunks.length : undefined,
        extraction_quality_score: quality?.score,
        extraction_quality_status: quality?.status,
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
    download: (document: DocumentEntity) => Promise<Uint8Array>;
    storage?: CachedStorage;
    executionMode?: IngestExecutionMode;
  },
): Promise<MaterializedDocumentResult> {
  if (!document.original_url) {
    return { document, cacheHit: false, issues: [] };
  }

  if (options.storage) {
    if (options.executionMode === "rederive_cached") {
      const rederived = await rederiveFromStoredFile(document, options.storage);
      if (rederived) {
        return rederived;
      }
    } else {
      const cached = await readCachedDocument(document, options.storage);
      if (cached) {
        return cached;
      }

      const canBackfillPageChunks =
        document.content_type?.toLowerCase().includes("pdf") ||
        document.file_name?.toLowerCase().endsWith(".pdf");
      if (canBackfillPageChunks) {
        const rederived = await rederiveFromStoredFile(document, options.storage);
        if (rederived) {
          return rederived;
        }
      }
    }
  }

  const bytes = await options.download(document);
  let mdText = "";
  let pageChunks = document.page_chunks ?? [];
  const issues: ExtractionIssue[] = [];

  try {
    const extraction = await extractDocumentMarkdown(bytes, {
      contentType: document.content_type,
      fileName: document.file_name,
    });
    mdText = extraction.markdown;
    pageChunks = extraction.pageChunks ?? [];
    issues.push(
      ...extraction.warnings.map((message) => ({
        severity: "warning" as const,
        step: "extract_text" as const,
        entity_id: document.id,
        message,
      })),
    );
  } catch (error) {
    issues.push({
      severity: "error",
      step: "extract_text",
      entity_id: document.id,
      message: `${documentIssueContext(document)}: ${error instanceof Error ? error.message : "Document extraction failed"}`,
      details: issueDetailsFromError(error),
    });
  }

  let mediaUrls = document.media_urls;
  if (options.storage) {
    const stored = await options.storage.putObject(objectKey(document), bytes, {
      contentType: document.content_type,
      metadata: {
        entity_id: document.id,
        source: document.source_info.source,
      },
    });
    if (mdText) {
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
    }
    if (pageChunks.length > 0) {
      await options.storage.putObject(
        extractedPageChunksKey(document),
        new TextEncoder().encode(JSON.stringify({ pages: pageChunks })),
        {
          contentType: "application/json; charset=utf-8",
          metadata: {
            entity_id: document.id,
            source: document.source_info.source,
            kind: "pdf_page_chunks",
          },
        },
      );
    }
    mediaUrls = [
      {
        url: stored.url,
        original_url: document.original_url,
        content_type: document.content_type,
      },
    ];
  }

  const quality = mdText ? assessMarkdownQuality(mdText) : null;

  return {
    cacheHit: false,
    issues,
    document: {
      ...document,
      md_text: mdText ? [mdText] : undefined,
      page_chunks: pageChunks.length > 0 ? pageChunks : undefined,
      derived_content:
        options.storage && (mdText || pageChunks.length > 0)
          ? {
              markdown_key: mdText ? extractedMarkdownKey(document) : undefined,
              page_chunks_key: pageChunks.length > 0 ? extractedPageChunksKey(document) : undefined,
              page_count: pageChunks.length > 0 ? pageChunks.length : undefined,
              extraction_quality_score: quality?.score,
              extraction_quality_status: quality?.status,
            }
          : undefined,
      media_urls: mediaUrls,
    },
  };
}
