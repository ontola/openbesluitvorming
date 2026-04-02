import { buildEntityCommitEvent } from "./events/entity_commit.ts";
import { IbabsMeetingExtractor } from "./ibabs/extractor.ts";
import { NotubizMeetingExtractor } from "./notubiz/extractor.ts";
import {
  appendRunIssue,
  createRun,
  findActiveRun,
  getRunIssueCount,
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

function getExtractor(source: SourceDefinition): NotubizMeetingExtractor | IbabsMeetingExtractor {
  if (source.supplier === "notubiz") {
    return new NotubizMeetingExtractor();
  }

  return new IbabsMeetingExtractor();
}

async function executeIngest(
  run: IngestRunRecord,
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
  if (
    options.executionMode === "reindex_only" ||
    options.executionMode === "retry_failed_documents"
  ) {
    throw new Error(`Execution mode "${options.executionMode}" is not implemented yet.`);
  }

  try {
    const source = getSource(sourceKey);
    const extractor = getExtractor(source);
    let currentRun = run;
    let quickwit: QuickwitClient | null = null;
    let quickwitIndexId: string | undefined;
    const pendingEvents: Array<EntityCommitEvent<WooziEntity>> = [];

    const flushQuickwitBatch = async (): Promise<void> => {
      if (!quickwit || pendingEvents.length === 0) {
        return;
      }
      const batch = pendingEvents.splice(0, pendingEvents.length);
      await quickwit.ingestEvents(batch);
    };

    if (options.ingestToQuickwit) {
      quickwit = new QuickwitClient();
      const configPath = new URL("../quickwit/index-config.json", import.meta.url);
      await quickwit.waitUntilReady();
      await quickwit.ensureIndex(configPath.pathname);
      quickwitIndexId = Deno.env.get("QUICKWIT_INDEX_ID") ?? "woozi-events";
    }

    const extraction = await extractor.extractForDateRange(source, dateFrom, dateTo, {
      executionMode: options.executionMode,
      retainEntities: false,
      retainIssues: false,
      onProgress: async (stats) => {
        currentRun = await updateRun(run.id, {
          meeting_count: stats.meeting_count,
          document_count: stats.document_count,
          cache_hits: stats.cache_hits,
          downloaded_count: stats.downloaded_count,
          issue_count: stats.issue_count,
        });
      },
      onIssue: async (issue, stats) => {
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
        if (!quickwit) {
          return;
        }
        pendingEvents.push(await buildEntityCommitEvent(entity));
        if (pendingEvents.length >= quickwitBatchSize) {
          await flushQuickwitBatch();
        }
      },
    });
    await flushQuickwitBatch();

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

  enqueueJob({
    run,
    sourceKey,
    dateFrom,
    dateTo,
    options,
  });
  void drainIngestQueue();

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
