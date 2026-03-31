import { buildEntityCommitEvent } from "./events/entity_commit.ts";
import { NotubizMeetingExtractor } from "./notubiz/extractor.ts";
import { updateRun, appendRunIssue, createRun } from "./ops/store.ts";
import { QuickwitClient } from "./quickwit/client.ts";
import { getNotubizSource } from "./sources/notubiz.ts";
import type { IngestRunRecord } from "./types.ts";

export async function runIngest(
  sourceKey: string,
  dateFrom: string,
  dateTo: string,
  options: {
    ingestToQuickwit?: boolean;
    trigger?: "manual" | "api";
  } = {},
): Promise<{
  run: IngestRunRecord;
  quickwit_index_id?: string;
}> {
  const source = getNotubizSource(sourceKey);
  const run = await createRun({
    source_key: source.key,
    supplier: source.supplier,
    date_from: dateFrom,
    date_to: dateTo,
    trigger: options.trigger ?? "manual",
  });

  try {
    const extractor = new NotubizMeetingExtractor();
    const extraction = await extractor.extractForDateRange(source, dateFrom, dateTo);

    for (const issue of extraction.issues) {
      await appendRunIssue(run.id, issue);
    }

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
    const updated = await updateRun(run.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: message,
    });
    throw new Error(`Run ${updated.id} failed: ${message}`);
  }
}
