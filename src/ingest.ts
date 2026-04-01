import { buildEntityCommitEvent } from "./events/entity_commit.ts";
import { IbabsMeetingExtractor } from "./ibabs/extractor.ts";
import { NotubizMeetingExtractor } from "./notubiz/extractor.ts";
import { updateRun, appendRunIssue, createRun, findActiveRun, getRunDetails } from "./ops/store.ts";
import { QuickwitClient } from "./quickwit/client.ts";
import { currentDerivationVersion, currentProjectionVersion } from "./pipeline/versioning.ts";
import { getSource } from "./sources/index.ts";
import type {
  IngestExecutionMode,
  IngestRunRecord,
  IngestRunTrigger,
  SourceDefinition,
} from "./types.ts";

const ingestConcurrency = Math.max(1, Number(Deno.env.get("INGEST_CONCURRENCY") ?? "1"));

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
    const extraction = await extractor.extractForDateRange(source, dateFrom, dateTo, {
      executionMode: options.executionMode,
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
    });

    const events = await Promise.all(
      [...extraction.meetings, ...extraction.documents].map((entity) =>
        buildEntityCommitEvent(entity),
      ),
    );

    let quickwitIndexId: string | undefined;
    if (options.ingestToQuickwit) {
      const quickwit = new QuickwitClient();
      const configPath = new URL("../quickwit/index-config.json", import.meta.url);
      await quickwit.waitUntilReady();
      await quickwit.ensureIndex(configPath.pathname);
      await quickwit.ingestEvents(events);
      quickwitIndexId = "woozi-events";
    }

    const status = extraction.issues.length > 0 ? "partial" : "succeeded";
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
    const details = await getRunDetails(run.id);
    const updated = await updateRun(run.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: message,
      issue_count: details?.issues.length ?? 1,
    });
    throw new Error(`Run ${updated.id} failed: ${message}`);
  }
}

async function drainIngestQueue(): Promise<void> {
  while (activeIngestCount < ingestConcurrency && pendingJobs.length > 0) {
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

  pendingJobs.push({
    run,
    sourceKey,
    dateFrom,
    dateTo,
    options,
  });
  void drainIngestQueue();

  return run;
}
