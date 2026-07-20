import type { DocumentEntity, DocumentPageChunk, ExtractionIssue } from "../types.ts";
import { extractDocumentMarkdown, MAX_PDF_PAGES } from "./text.ts";
import type { IngestExecutionMode } from "../types.ts";
import { assessMarkdownQuality } from "./quality.ts";
import { scanForBsn } from "./bsn.ts";
import { addDocumentToBlocklist, isDocumentBlocklisted } from "../ops/store.ts";
import { currentDerivationVersion } from "../pipeline/versioning.ts";
import { pdfPageCacheKey, pdfPageMetaKey, renderPdfPageJpeg } from "./thumbnails.ts";

let extractionServiceUrls: string[] | null = null;
let extractionRoundRobin = 0;

// A node that's merely handling a slow source download looks identical to a
// genuinely overloaded one from a single request's timeout — so routing
// can't infer node health from document-level failures without punishing
// healthy nodes that happen to draw a bad batch of source URLs. Instead,
// probe each node's own /health directly (cheap: <20ms when healthy) and
// cache the verdict briefly, so an overloaded node (observed: 2 vCPU node at
// load 4+, its own /health not answering within 10s) gets skipped for
// EXTRACTION_HEALTH_TTL_MS instead of eating a full 3-minute request timeout.
const EXTRACTION_HEALTH_TTL_MS = 15_000;
const EXTRACTION_HEALTH_CHECK_TIMEOUT_MS = 2_000;
const extractionHealthCache = new Map<string, { healthy: boolean; checkedAt: number }>();

function extractionServiceUrlList(): string[] {
  if (extractionServiceUrls === null) {
    const raw = Deno.env.get("WOOZI_EXTRACTION_SERVICE_URL")?.trim();
    extractionServiceUrls = raw
      ? raw
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean)
      : [];
  }
  return extractionServiceUrls;
}

async function checkExtractionUrlHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(EXTRACTION_HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isExtractionUrlHealthy(url: string): Promise<boolean> {
  const cached = extractionHealthCache.get(url);
  const now = Date.now();
  if (cached && now - cached.checkedAt < EXTRACTION_HEALTH_TTL_MS) {
    return cached.healthy;
  }
  const healthy = await checkExtractionUrlHealth(url);
  extractionHealthCache.set(url, { healthy, checkedAt: now });
  return healthy;
}

async function nextExtractionServiceUrl(): Promise<string | null> {
  const urls = extractionServiceUrlList();
  if (urls.length === 0) return null;

  // Try each URL starting from the round-robin cursor, skipping ones whose
  // cached health check currently says down. If every candidate is
  // unhealthy (or the cache is cold), fall through to plain round-robin
  // rather than blocking ingestion entirely.
  for (let i = 0; i < urls.length; i++) {
    const candidate = urls[(extractionRoundRobin + i) % urls.length];
    const cached = extractionHealthCache.get(candidate);
    const isStale = !cached || Date.now() - cached.checkedAt >= EXTRACTION_HEALTH_TTL_MS;
    if (isStale || cached.healthy) {
      extractionRoundRobin = (extractionRoundRobin + i + 1) % urls.length;
      if (isStale) {
        // Don't block this pick on a fresh probe; kick one off for next time.
        void isExtractionUrlHealthy(candidate);
      }
      return candidate;
    }
  }

  const url = urls[extractionRoundRobin % urls.length];
  extractionRoundRobin = (extractionRoundRobin + 1) % urls.length;
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
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".opus",
  ".aac",
  ".flac",
  ".mp4",
  ".m4v",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
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
  deleteObjects?(keys: string[]): Promise<void>;
}

async function prewarmFirstPageThumbnail(
  document: DocumentEntity,
  storage: CachedStorage,
  pdfBytes: Uint8Array,
): Promise<void> {
  if (!isPdf(document)) {
    return;
  }

  const startedAt = performance.now();
  const thumbnailKey = pdfPageCacheKey(document.id, 1);
  if (await storage.hasObject(thumbnailKey)) {
    return;
  }

  try {
    const rendered = await renderPdfPageJpeg(pdfBytes, 1);
    await storage.putObject(thumbnailKey, rendered.imageBytes, {
      contentType: "image/jpeg",
      metadata: {
        entity_id: document.id,
        source: document.source_info.source,
        kind: "pdf_page_thumbnail",
        page_number: "1",
      },
    });
    if (rendered.pageCount !== null && rendered.pageCount > 0) {
      await storage.putObject(
        pdfPageMetaKey(document.id),
        new TextEncoder().encode(JSON.stringify({ page_count: rendered.pageCount })),
        {
          contentType: "application/json; charset=utf-8",
          metadata: {
            entity_id: document.id,
            source: document.source_info.source,
            kind: "pdf_page_metadata",
          },
        },
      );
    }
    console.log(
      `[timing] ${document.id} path=thumbnail_prewarm ${Math.round(performance.now() - startedAt)}ms`,
    );
  } catch (error) {
    console.warn(
      `[warning] ${document.id} thumbnail_prewarm_failed ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
  /** True when the document is blocklisted or quarantined (e.g. it contains a
   * BSN). The ingest onEntity handler skips indexing/export for these. */
  blocked?: boolean;
}

/** Auto-quarantine is opt-in (decision after consulting VNG, July 2026):
 * detection currently only reports, it never blocks or deletes on its own.
 * Documents are only ever blocked via the explicit blocklist (delete script).
 * Set WOOZI_BSN_AUTO_QUARANTINE=1 to make high-confidence hits preventive. */
function bsnAutoQuarantineEnabled(): boolean {
  return Deno.env.get("WOOZI_BSN_AUTO_QUARANTINE")?.trim() === "1";
}

/** Scans extracted markdown for BSNs. By default every hit only adds a review
 * issue (detect-only). With WOOZI_BSN_AUTO_QUARANTINE=1, high-confidence hits
 * are blocklisted and quarantined: already-written S3 artifacts are removed
 * and a blocked result is returned so the document is never indexed. Returns
 * null when ingestion should continue. */
async function quarantineBsnDocument(
  document: DocumentEntity,
  markdown: string,
  storage: CachedStorage | undefined,
  writtenKeys: string[],
  issues: ExtractionIssue[],
): Promise<MaterializedDocumentResult | null> {
  if (!markdown) {
    return null;
  }
  const scan = scanForBsn(markdown);
  if (!scan.found) {
    return null;
  }

  const details = JSON.stringify(scan.matches.slice(0, 10));
  if (scan.confidence !== "high" || !bsnAutoQuarantineEnabled()) {
    issues.push({
      severity: "warning",
      step: "bsn_quarantine",
      entity_id: document.id,
      message: `${documentIssueContext(document)}: possible BSN detected (${scan.matches.length} match(es), ${scan.confidence} confidence); manual review needed`,
      details,
    });
    return null;
  }

  await addDocumentToBlocklist(document.id, "bsn-auto", details);
  if (storage?.deleteObjects && writtenKeys.length > 0) {
    try {
      await storage.deleteObjects(writtenKeys);
    } catch (error) {
      issues.push({
        severity: "warning",
        step: "bsn_quarantine",
        entity_id: document.id,
        message: `${documentIssueContext(document)}: failed to remove S3 objects after BSN quarantine: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  issues.push({
    severity: "error",
    step: "bsn_quarantine",
    entity_id: document.id,
    message: `${documentIssueContext(document)}: BSN detected (${scan.matches.length} match(es)); document blocklisted and not indexed`,
    details,
  });
  console.warn(`[bsn] ${document.id} quarantined (${scan.matches.length} matches)`);
  return {
    blocked: true,
    cacheHit: false,
    issues,
    document,
  };
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

  const quarantined = await quarantineBsnDocument(
    document,
    mdText,
    storage,
    [fileKey, extractedMarkdownKey(document), extractedPageChunksKey(document)],
    issues,
  );
  if (quarantined) {
    return quarantined;
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

  await prewarmFirstPageThumbnail(document, storage, storedBytes);

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
    console.log(
      `[timing] ${docId} path=skip_media ${Math.round(performance.now() - t0)}ms file=${document.file_name ?? ""}`,
    );
    return { document, cacheHit: false, issues: [] };
  }

  // Blocklisted documents (taken down, e.g. for containing a BSN) must never
  // be re-downloaded or re-materialized. This check runs before the S3
  // cache-hit short-circuit on purpose.
  if (await isDocumentBlocklisted(docId)) {
    console.log(`[timing] ${docId} path=blocklist_skip ${Math.round(performance.now() - t0)}ms`);
    return { document, cacheHit: true, issues: [], blocked: true };
  }

  // Where the extraction service should download the document. Normally the
  // supplier's URL; for a page-chunks repair pass it is our own cached PDF.
  let serviceSourceUrl = document.original_url;
  let pageRepairFallback: MaterializedDocumentResult | null = null;

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
        // Documents extracted through the service before July 2026 got no
        // per-page chunks (no DocumentPage rows, no jump-to-matched-page).
        // Repair them on touch: re-extract from our own cached PDF — never
        // from the supplier, whose copy may be gone — and fall back to the
        // plain cache hit if the service can't do it.
        if (
          !cached.document.derived_content?.page_chunks_key &&
          hasExtractionService() &&
          isPdf(document)
        ) {
          pageRepairFallback = cached;
          serviceSourceUrl = options.storage.urlForKey(objectKey(document));
        } else {
          console.log(`[timing] ${docId} path=cache_hit ${Math.round(performance.now() - t0)}ms`);
          return cached;
        }
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
  const serviceUrl = hasExtractionService() && isPdf(document) && document.original_url &&
      options.storage
    ? await nextExtractionServiceUrl()
    : null;
  if (serviceUrl && isPdf(document) && document.original_url && options.storage) {
    const pdfKey = objectKey(document);
    const mdKey = extractedMarkdownKey(document);
    const issues: ExtractionIssue[] = [];

    const EXTRACTION_TIMEOUT_MS = 180_000; // 3 minutes — p99 is ~127s
    // Under backfill load iBabs drops connections and times out mid-download;
    // the service maps those to 422 and a fresh attempt usually succeeds.
    // Truly dead sources keep their own 4xx status ("Source returned 404")
    // and are never retried, nor is our own 3-minute timeout — repeating a
    // full timeout only deepens the congestion that caused it.
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1_500;

    let lastError: unknown;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      attemptsMade = attempt;
      // Pick a different worker on each retry so we don't hammer a slow/down node
      const attemptUrl = attempt === 1 ? serviceUrl : ((await nextExtractionServiceUrl()) ?? serviceUrl);
      try {
        const response = await fetch(`${attemptUrl}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
          body: JSON.stringify({
            source_url: serviceSourceUrl,
            s3_pdf_key: pdfKey,
            s3_markdown_key: mdKey,
            s3_page_chunks_key: extractedPageChunksKey(document),
            s3_thumbnail_key: pdfPageCacheKey(document.id, 1),
            s3_thumbnail_meta_key: pdfPageMetaKey(document.id),
            max_pages: MAX_PDF_PAGES,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error = new Error(`Extraction service returned ${response.status}: ${body}`);
          // 422 is the service's wrapper around download/extraction exceptions
          // (disconnects, read timeouts) and 408/5xx are transient by nature;
          // any other 4xx means the source document itself is gone.
          const retryable = response.status === 422 || response.status === 408 ||
            response.status >= 500;
          if (!retryable) {
            lastError = error;
            break;
          }
          throw error;
        }

        const payload = (await response.json()) as {
          markdown: string;
          page_chunks?: DocumentPageChunk[];
          page_count: number;
          warnings: string[];
          s3_pdf_url: string;
        };
        const pageChunks = (payload.page_chunks ?? []).filter(
          (page) => typeof page?.page_number === "number" && typeof page?.markdown === "string",
        );

        issues.push(
          ...payload.warnings.map((message) => ({
            severity: "warning" as const,
            step: "extract_text" as const,
            entity_id: document.id,
            message,
          })),
        );

        const quarantined = await quarantineBsnDocument(
          document,
          payload.markdown,
          options.storage,
          [
            pdfKey,
            mdKey,
            extractedPageChunksKey(document),
            pdfPageCacheKey(document.id, 1),
            pdfPageMetaKey(document.id),
          ],
          issues,
        );
        if (quarantined) {
          return quarantined;
        }

        const quality = payload.markdown ? assessMarkdownQuality(payload.markdown) : null;
        console.log(
          `[timing] ${docId} path=${pageRepairFallback ? "page_repair" : "extraction_service"} ${Math.round(performance.now() - t0)}ms pages=${payload.page_count} md=${Math.round(payload.markdown.length / 1024)}KB`,
        );

        return {
          cacheHit: false,
          issues,
          document: {
            ...document,
            md_text: payload.markdown ? [payload.markdown] : undefined,
            page_chunks: pageChunks.length > 0 ? pageChunks : document.page_chunks,
            derived_content: {
              markdown_key: mdKey,
              page_chunks_key: pageChunks.length > 0 ? extractedPageChunksKey(document) : undefined,
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
        if (error instanceof DOMException && error.name === "TimeoutError") {
          break;
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        }
      }
    }

    // Retries exhausted. A failed page-chunks repair keeps the plain cache
    // hit (the document stays searchable; only the page granularity is still
    // missing) — a warning, not an error, so repair passes don't trip the
    // extraction-failure monitor.
    if (pageRepairFallback) {
      issues.push({
        severity: "warning",
        step: "extract_text",
        entity_id: document.id,
        message: `${documentIssueContext(document)}: page-chunks repair failed, keeping cached markdown: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        details: issueDetailsFromError(lastError),
      });
      console.log(
        `[timing] ${docId} path=page_repair_failed ${Math.round(performance.now() - t0)}ms`,
      );
      return { ...pageRepairFallback, issues };
    }

    // Record as issue and continue without extraction
    issues.push({
      severity: "error",
      step: "extract_text",
      entity_id: document.id,
      message: `${documentIssueContext(document)}: Extraction service failed after ${attemptsMade} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      details: issueDetailsFromError(lastError),
    });

    console.log(
      `[timing] ${docId} path=extraction_service_failed ${Math.round(performance.now() - t0)}ms`,
    );
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

  const quarantined = await quarantineBsnDocument(document, mdText, options.storage, [], issues);
  if (quarantined) {
    return quarantined;
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
    await prewarmFirstPageThumbnail(document, options.storage, bytes);
    mediaUrls = [
      {
        url: stored.url,
        original_url: document.original_url,
        content_type: document.content_type,
      },
    ];
  }

  const quality = mdText ? assessMarkdownQuality(mdText) : null;
  console.log(
    `[timing] ${docId} path=local_fallback total=${Math.round(performance.now() - t0)}ms dl=${dlMs}ms bytes=${Math.round(bytes.length / 1024)}KB md=${Math.round(mdText.length / 1024)}KB`,
  );

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
