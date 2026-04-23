import type { DocumentEntity, ExtractionIssue } from "../types.ts";
import { extractDocumentMarkdown, MAX_PDF_PAGES } from "./text.ts";
import type { IngestExecutionMode } from "../types.ts";
import { assessMarkdownQuality } from "./quality.ts";
import { currentDerivationVersion } from "../pipeline/versioning.ts";

let extractionServiceUrls: string[] | null = null;
let extractionRoundRobin = 0;

function nextExtractionServiceUrl(): string | null {
  if (extractionServiceUrls === null) {
    const raw = Deno.env.get("WOOZI_EXTRACTION_SERVICE_URL")?.trim();
    extractionServiceUrls = raw
      ? raw.split(",").map((u) => u.trim()).filter(Boolean)
      : [];
  }
  if (extractionServiceUrls.length === 0) return null;
  const url = extractionServiceUrls[extractionRoundRobin % extractionServiceUrls.length];
  extractionRoundRobin++;
  return url;
}

function hasExtractionService(): boolean {
  if (extractionServiceUrls !== null) return extractionServiceUrls.length > 0;
  return Boolean(Deno.env.get("WOOZI_EXTRACTION_SERVICE_URL")?.trim());
}

function isPdf(document: DocumentEntity): boolean {
  return (
    document.content_type?.toLowerCase().includes("pdf") === true ||
    document.file_name?.toLowerCase().endsWith(".pdf") === true
  );
}

// Media we cannot text-search. Audio/video meeting recordings are large
// (tens to hundreds of MB) and repeatedly blow out S3 write timeouts in the
// local fallback path. Skipping them entirely saves both the download and
// the failed S3 write retry storm — Hilversum's "Geluidsbestand agendapunt"
// MP3s alone generated ~6k failures in a week.
const UNSEARCHABLE_MEDIA_EXTENSIONS = [
  ".mp3", ".m4a", ".wav", ".ogg", ".opus", ".aac", ".flac",
  ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm",
];

function isUnsearchableMedia(document: DocumentEntity): boolean {
  const ct = document.content_type?.toLowerCase() ?? "";
  if (ct.startsWith("audio/") || ct.startsWith("video/")) return true;
  const name = document.file_name?.toLowerCase() ?? "";
  return UNSEARCHABLE_MEDIA_EXTENSIONS.some((ext) => name.endsWith(ext));
}

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
  // Check all three keys in parallel to minimize S3 latency.
  const [hasFile, hasMarkdown, hasPageChunks] = await Promise.all([
    storage.hasObject(fileKey),
    storage.hasObject(markdownKey),
    storage.hasObject(pageChunksKey),
  ]);

  if (!hasFile || !hasMarkdown) {
    return null;
  }

  // Don't download markdown or page chunks from S3 — just confirm they exist.
  // The document was already indexed in a previous run. Re-downloading the
  // markdown just to re-index it costs 4+ seconds per document in S3 latency
  // and dominates import time for cached documents.
  return {
    cacheHit: true,
    issues: [],
    document: {
      ...document,
      derived_content: {
        markdown_key: markdownKey,
        page_chunks_key: hasPageChunks ? pageChunksKey : undefined,
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
  const t0 = performance.now();
  const docId = document.id;

  if (!document.original_url) {
    return { document, cacheHit: false, issues: [] };
  }

  if (isUnsearchableMedia(document)) {
    console.log(`[timing] ${docId} path=skip_media ${Math.round(performance.now() - t0)}ms file=${document.file_name ?? ""}`);
    return { document, cacheHit: false, issues: [] };
  }

  if (options.storage) {
    if (options.executionMode === "rederive_cached" && !hasExtractionService()) {
      const rederived = await rederiveFromStoredFile(document, options.storage);
      if (rederived) {
        console.log(`[timing] ${docId} path=rederive ${Math.round(performance.now() - t0)}ms`);
        return rederived;
      }
    } else {
      const cached = await readCachedDocument(document, options.storage);
      if (cached) {
        console.log(`[timing] ${docId} path=cache_hit ${Math.round(performance.now() - t0)}ms`);
        return cached;
      }

      // Skip local rederivation when extraction service is configured —
      // rederiveFromStoredFile downloads the PDF from S3 and runs pymupdf4llm
      // locally, which can OOM the server. Let it fall through to the
      // extraction service path below instead.
      if (!hasExtractionService()) {
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
  }

  // When extraction service is configured and the document is a PDF,
  // delegate download + extraction + S3 upload to the extraction worker.
  // The ingest server never holds the PDF bytes in memory.
  const serviceUrl = nextExtractionServiceUrl();
  if (serviceUrl && isPdf(document) && document.original_url && options.storage) {
    const pdfKey = objectKey(document);
    const mdKey = extractedMarkdownKey(document);
    const issues: ExtractionIssue[] = [];

    const EXTRACTION_TIMEOUT_MS = 180_000; // 3 minutes — p99 is ~127s
    // One attempt only. Retries don't help when the source PDF server is slow
    // (the bottleneck is source download, not the extractor), and a second
    // attempt doubles the worst-case slot-block time.
    const MAX_RETRIES = 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Pick a different worker on each retry so we don't hammer a slow/down node
      const attemptUrl = attempt === 1 ? serviceUrl : (nextExtractionServiceUrl() ?? serviceUrl);
      try {
        const response = await fetch(`${attemptUrl}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
          body: JSON.stringify({
            source_url: document.original_url,
            s3_pdf_key: pdfKey,
            s3_markdown_key: mdKey,
            max_pages: MAX_PDF_PAGES,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          // Don't retry on 4xx — the source document doesn't exist or isn't downloadable
          if (response.status >= 400 && response.status < 500) {
            lastError = new Error(`Extraction service returned ${response.status}: ${body}`);
            break;
          }
          throw new Error(`Extraction service returned ${response.status}: ${body}`);
        }

        const payload = (await response.json()) as {
          markdown: string;
          page_count: number;
          warnings: string[];
          s3_pdf_url: string;
        };

        issues.push(
          ...payload.warnings.map((message) => ({
            severity: "warning" as const,
            step: "extract_text" as const,
            entity_id: document.id,
            message,
          })),
        );

        const quality = payload.markdown ? assessMarkdownQuality(payload.markdown) : null;
        console.log(`[timing] ${docId} path=extraction_service ${Math.round(performance.now() - t0)}ms pages=${payload.page_count} md=${Math.round(payload.markdown.length / 1024)}KB`);

        return {
          cacheHit: false,
          issues,
          document: {
            ...document,
            md_text: payload.markdown ? [payload.markdown] : undefined,
            derived_content: {
              markdown_key: mdKey,
              page_count: payload.page_count > MAX_PDF_PAGES ? MAX_PDF_PAGES : payload.page_count,
              extraction_quality_score: quality?.score,
              extraction_quality_status: quality?.status,
            },
            media_urls: [
              {
                url: payload.s3_pdf_url,
                original_url: document.original_url,
                content_type: document.content_type,
              },
            ],
          },
        };
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    // Retries exhausted — record as issue and continue without extraction
    issues.push({
      severity: "error",
      step: "extract_text",
      entity_id: document.id,
      message: `${documentIssueContext(document)}: Extraction service failed after ${MAX_RETRIES} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      details: issueDetailsFromError(lastError),
    });

    console.log(`[timing] ${docId} path=extraction_service_failed ${Math.round(performance.now() - t0)}ms`);
    return { document, cacheHit: false, issues };
  }

  // Fallback: local download + extraction (no extraction service configured,
  // or document is not a PDF)
  const tDl = performance.now();
  const bytes = await options.download(document);
  const dlMs = Math.round(performance.now() - tDl);
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
  console.log(`[timing] ${docId} path=local_fallback total=${Math.round(performance.now() - t0)}ms dl=${dlMs}ms bytes=${Math.round(bytes.length / 1024)}KB md=${Math.round(mdText.length / 1024)}KB`);

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
