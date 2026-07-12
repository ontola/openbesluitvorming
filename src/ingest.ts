import { buildEntityCommitEvent } from "./events/entity_commit.ts";
import { getExportLog } from "./exports/log.ts";
import { GemeenteOplossingenExtractor } from "./gemeenteoplossingen/extractor.ts";
import { IbabsMeetingExtractor } from "./ibabs/extractor.ts";
import { NotubizMeetingExtractor } from "./notubiz/extractor.ts";
import { ParlaeusExtractor } from "./parlaeus/extractor.ts";
import type { QuickwitSearchDocument } from "./quickwit/project.ts";
import { projectEntityCommitToQuickwitDocuments } from "./quickwit/project.ts";
import {
  appendRunIssue,
  createRun,
  findActiveRun,
  getRunIssueCount,
  isDocumentBlocklisted,
  listQueuedRuns,
  updateRun,
} from "./ops/store.ts";
import { QuickwitClient } from "./quickwit/client.ts";
import { currentDerivationVersion, currentProjectionVersion } from "./pipeline/versioning.ts";
import { getSource } from "./sources/index.ts";
import { computeAllowedIngestConcurrency } from "./ingest_scheduler.ts";
import type {
  EntityCommitEvent,
  IngestExecutionMode,
  IngestRunRecord,
  IngestRunTrigger,
  SourceDefinition,
  WooziEntity,
} from "./types.ts";

const ingestConcurrencyCap = Math.max(1, Number(Deno.env.get("INGEST_CONCURRENCY") ?? "4"));
const ingestMemoryPerJobMb = Math.max(
  256,
  Number(Deno.env.get("INGEST_MEMORY_PER_JOB_MB") ?? "1400"),
);
const ingestMinFreeMemoryMb = Math.max(
  256,
  Number(Deno.env.get("INGEST_MIN_FREE_MEMORY_MB") ?? "1024"),
);
const quickwitBatchSize = Math.max(1, Number(Deno.env.get("QUICKWIT_BATCH_SIZE") ?? "64"));

type QueuedIngestJob = {
  run: IngestRunRecord;
  sourceKey: string;
  dateFrom: string;
  dateTo: string;
  options: {
    ingestToQuickwit?: boolean;
    trigger?: IngestRunTrigger;
    executionMode?: IngestExecutionMode;
    parentRunId?: string;
  };
};

const pendingJobs: QueuedIngestJob[] = [];
let activeIngestCount = 0;

function getAllowedIngestConcurrency(): number {
  try {
    const memory = Deno.systemMemoryInfo();
    return computeAllowedIngestConcurrency({
      configuredConcurrency: ingestConcurrencyCap,
      availableMemoryBytes: memory.available,
      memoryPerJobMb: ingestMemoryPerJobMb,
      minFreeMemoryMb: ingestMinFreeMemoryMb,
    });
  } catch {
    return ingestConcurrencyCap;
  }
}

function enqueueJob(job: QueuedIngestJob): void {
  if (pendingJobs.some((candidate) => candidate.run.id === job.run.id)) {
    return;
  }
  pendingJobs.push(job);
}

// Use the widest extractor's option type. GemeenteOplossingen and Parlaeus emit
// Committee/Party/Person on top of Meeting/Document, so their onEntity signature
// is a superset of the legacy Notubiz/iBabs ones — TS is happy passing the
// narrower handler into a place expecting the wider one because of param
// contravariance.
type ExtractorOptions = Parameters<GemeenteOplossingenExtractor["extractForDateRange"]>[3];

function runExtractor(
  source: SourceDefinition,
  dateFrom: string,
  dateTo: string,
  options: ExtractorOptions,
) {
  if (source.supplier === "notubiz") {
    return new NotubizMeetingExtractor().extractForDateRange(source, dateFrom, dateTo, options);
  }

  if (source.supplier === "gemeenteoplossingen") {
    return new GemeenteOplossingenExtractor().extractForDateRange(
      source,
      dateFrom,
      dateTo,
      options,
    );
  }

  if (source.supplier === "parlaeus") {
    return new ParlaeusExtractor().extractForDateRange(source, dateFrom, dateTo, options);
  }

  return new IbabsMeetingExtractor().extractForDateRange(source, dateFrom, dateTo, options);
}

export async function executeIngest(
  run: IngestRunRecord,
  sourceKey: string,
  dateFrom: string,
  dateTo: string,
  options: {
    ingestToQuickwit?: boolean;
    trigger?: IngestRunTrigger;
    executionMode?: IngestExecutionMode;
    parentRunId?: string;
    /** Called on every sign of extraction progress, so a watchdog can tell a
     * live-but-slow run apart from a wedged one. */
    onHeartbeat?: () => void;
  } = {},
): Promise<{
  run: IngestRunRecord;
  quickwit_index_id?: string;
}> {
  if (
    options.executionMode === "reindex_only" ||
    options.executionMode === "retry_failed_documents"
  ) {
    throw new Error(`Execution mode "${options.executionMode}" is not implemented yet.`);
  }

  try {
    const source = getSource(sourceKey);
    let currentRun = run;
    let quickwit: QuickwitClient | null = null;
    let quickwitIndexId: string | undefined;
    const pendingDocuments: QuickwitSearchDocument[] = [];

    const flushQuickwitBatch = async (): Promise<void> => {
      if (!quickwit || pendingDocuments.length === 0) {
        return;
      }
      const batch = pendingDocuments.splice(0, pendingDocuments.length);
      await quickwit.ingestDocuments(batch);
    };

    if (options.ingestToQuickwit) {
      quickwit = new QuickwitClient();
      const configPath = new URL("../quickwit/index-config.json", import.meta.url);
      await quickwit.waitUntilReady();
      await quickwit.ensureIndex(configPath.pathname);
      quickwitIndexId = Deno.env.get("QUICKWIT_INDEX_ID") ?? "woozi-events";
    }

    const exportLog = options.ingestToQuickwit ? await getExportLog() : null;

    const extraction = await runExtractor(source, dateFrom, dateTo, {
      executionMode: options.executionMode,
      retainEntities: false,
      retainIssues: false,
      onProgress: async (stats) => {
        options.onHeartbeat?.();
        currentRun = await updateRun(run.id, {
          meeting_count: stats.meeting_count,
          document_count: stats.document_count,
          cache_hits: stats.cache_hits,
          downloaded_count: stats.downloaded_count,
          issue_count: stats.issue_count,
        });
      },
      onIssue: async (issue, stats) => {
        options.onHeartbeat?.();
        await appendRunIssue(run.id, issue);
        currentRun = await updateRun(run.id, {
          meeting_count: stats.meeting_count,
          document_count: stats.document_count,
          cache_hits: stats.cache_hits,
          downloaded_count: stats.downloaded_count,
          issue_count: stats.issue_count,
        });
      },
      onEntity: async (entity) => {
        options.onHeartbeat?.();
        // Blocklisted documents (taken down, e.g. BSN) are neither indexed nor
        // exported. materializeDocument also refuses to re-materialize them,
        // but this guard covers every extractor path centrally.
        if (entity.type === "Document" && (await isDocumentBlocklisted(entity.id))) {
          console.log(`[blocklist] ${sourceKey} skipped ${entity.id}`);
          return;
        }
        const mem = Deno.memoryUsage();
        const rss = Math.round(mem.rss / 1024 / 1024);
        const heap = Math.round(mem.heapUsed / 1024 / 1024);
        const mdSize =
          entity.type === "Document" && entity.md_text
            ? entity.md_text.reduce((a, b) => a + b.length, 0)
            : 0;
        const chunksSize =
          entity.type === "Document" && entity.page_chunks
            ? JSON.stringify(entity.page_chunks).length
            : 0;
        console.log(
          `[mem] ${sourceKey} entity=${entity.type} rss=${rss}MB heap=${heap}MB pending=${pendingDocuments.length} md=${Math.round(mdSize / 1024)}KB chunks=${Math.round(chunksSize / 1024)}KB`,
        );
        if (!quickwit) {
          return;
        }
        // Project immediately to compact Quickwit documents and discard the
        // large entity (md_text, page_chunks, raw) right away. Only the small
        // projected documents are buffered until the next flush.
        const event = await buildEntityCommitEvent(entity);
        exportLog?.recordCommit(event);
        const projected = projectEntityCommitToQuickwitDocuments(event);
        pendingDocuments.push(...projected);
        if (pendingDocuments.length >= quickwitBatchSize) {
          await flushQuickwitBatch();
        }
      },
    });
    await flushQuickwitBatch();

    if (exportLog) {
      try {
        await exportLog.flush(source.key);
      } catch (error) {
        // Segment publishing is retried implicitly: unflushed records stay in
        // the pending table, remain readable via the changes endpoint, and are
        // included in the next successful flush.
        await appendRunIssue(run.id, {
          severity: "warning",
          step: "export_log_flush",
          message: error instanceof Error ? error.message : "Export log flush failed",
        });
      }
    }

    const status = extraction.stats.issue_count > 0 ? "partial" : "succeeded";
    const updated = await updateRun(run.id, {
      ...currentRun,
      status,
      finished_at: new Date().toISOString(),
      meeting_count: extraction.stats.meeting_count,
      document_count: extraction.stats.document_count,
      cache_hits: extraction.stats.cache_hits,
      downloaded_count: extraction.stats.downloaded_count,
      issue_count: extraction.stats.issue_count,
      quickwit_index_id: quickwitIndexId,
    });

    return {
      run: updated,
      quickwit_index_id: quickwitIndexId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction failed";
    await appendRunIssue(run.id, {
      severity: "error",
      step: "ingest_quickwit",
      message,
    });
    const issueCount = await getRunIssueCount(run.id);
    const updated = await updateRun(run.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: message,
      issue_count: issueCount || 1,
    });
    throw new Error(`Run ${updated.id} failed: ${message}`);
  }
}

async function drainIngestQueue(): Promise<void> {
  while (pendingJobs.length > 0) {
    const allowedConcurrency = getAllowedIngestConcurrency();
    if (activeIngestCount >= allowedConcurrency) {
      return;
    }

    const job = pendingJobs.shift();
    if (!job) {
      return;
    }

    activeIngestCount += 1;
    void (async () => {
      try {
        const runningRun = await updateRun(job.run.id, {
          status: "running",
          error_message: undefined,
        });
        await executeIngest(runningRun, job.sourceKey, job.dateFrom, job.dateTo, job.options);
      } catch (error) {
        console.error("Background ingest failed", error);
      } finally {
        activeIngestCount -= 1;
        void drainIngestQueue();
      }
    })();
  }
}

export async function runIngest(
  sourceKey: string,
  dateFrom: string,
  dateTo: string,
  options: {
    ingestToQuickwit?: boolean;
    trigger?: IngestRunTrigger;
    executionMode?: IngestExecutionMode;
    parentRunId?: string;
  } = {},
): Promise<{
  run: IngestRunRecord;
  quickwit_index_id?: string;
}> {
  const source = getSource(sourceKey);
  const executionMode = options.executionMode ?? "full";
  const activeRun = await findActiveRun({
    sourceKey: source.key,
    dateFrom,
    dateTo,
    executionMode,
  });
  if (activeRun) {
    throw new Error(
      `Er draait al een import voor ${source.key} (${dateFrom} t/m ${dateTo}) met run ${activeRun.id}.`,
    );
  }

  const run = await createRun({
    source_key: source.key,
    supplier: source.supplier,
    date_from: dateFrom,
    date_to: dateTo,
    trigger: options.trigger ?? "user",
    execution_mode: executionMode,
    parent_run_id: options.parentRunId,
    projection_version: currentProjectionVersion(),
    derivation_version: currentDerivationVersion(),
  });

  return await executeIngest(run, sourceKey, dateFrom, dateTo, options);
}

export async function startIngest(
  sourceKey: string,
  dateFrom: string,
  dateTo: string,
  options: {
    ingestToQuickwit?: boolean;
    trigger?: IngestRunTrigger;
    executionMode?: IngestExecutionMode;
    parentRunId?: string;
  } = {},
): Promise<IngestRunRecord> {
  const source = getSource(sourceKey);
  const executionMode = options.executionMode ?? "full";
  const activeRun = await findActiveRun({
    sourceKey: source.key,
    dateFrom,
    dateTo,
    executionMode,
  });
  if (activeRun) {
    throw new Error(
      `Er draait al een import voor ${source.key} (${dateFrom} t/m ${dateTo}) met run ${activeRun.id}.`,
    );
  }

  const run = await createRun({
    source_key: source.key,
    supplier: source.supplier,
    date_from: dateFrom,
    date_to: dateTo,
    trigger: options.trigger ?? "user",
    execution_mode: executionMode,
    parent_run_id: options.parentRunId,
    status: "queued",
    projection_version: currentProjectionVersion(),
    derivation_version: currentDerivationVersion(),
  });

  return run;
}

export async function resumeQueuedIngests(): Promise<IngestRunRecord[]> {
  const runs = await listQueuedRuns();
  for (const run of runs) {
    enqueueJob({
      run,
      sourceKey: run.source_key,
      dateFrom: run.date_from,
      dateTo: run.date_to,
      options: {
        ingestToQuickwit: true,
        trigger: run.trigger,
        executionMode: run.execution_mode,
        parentRunId: run.parent_run_id,
      },
    });
  }
  void drainIngestQueue();
  return runs;
}
