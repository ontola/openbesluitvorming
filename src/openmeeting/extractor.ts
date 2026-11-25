import {
  type CachedStorage,
  materializeDocument,
  materializeInlineText,
} from "../documents/process.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import type {
  CommitteeEntity,
  DocumentEntity,
  ExtractedEntity,
  ExtractionBundle,
  ExtractionIssue,
  IngestExecutionMode,
  MeetingEntity,
  OpenMeetingSourceDefinition,
} from "../types.ts";
import { mapLimit } from "../util/map_limit.ts";
import { isPublicHttpsUrl, normalizePublishedMeeting } from "./normalize.ts";
import { amsterdamDay, PublishedMeetings, type PublishedStorage } from "./published.ts";

const DEFAULT_DOCUMENT_CONCURRENCY = 3;
const MAX_REDIRECTS = 3;

/** Downloads a published document, refusing every hop that is not a public
 * https address: the URL came from the publisher, and a redirect could
 * otherwise point the worker at something inside our own network. */
export async function downloadPublishedDocument(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isPublicHttpsUrl(current)) {
      throw new Error(`Refusing to download a non-public address (${current})`);
    }
    const response = await fetcher(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
      headers: { "user-agent": "woozi/0.1", accept: "*/*" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new Error(`Redirect without a location for ${current}`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Request failed ${response.status} for ${current}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new Error(`Too many redirects for ${url}`);
}

/** Reads what an OpenMeeting council published (src/openmeeting/published.ts)
 * and turns it into entities, like the extractors of the polled suppliers do
 * with their APIs. The documents go through the same materialization, so
 * caching, text extraction, BSN detection and the blocklist apply as they do
 * everywhere else. */
export class OpenMeetingExtractor {
  constructor(
    private readonly storageProvider: () => Promise<
      (PublishedStorage & CachedStorage) | undefined
    > = () => ObjectStorageClient.fromEnvironment(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async extractForDateRange(
    source: OpenMeetingSourceDefinition,
    dateFrom: string,
    dateTo: string,
    options: {
      onProgress?: (stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onIssue?: (issue: ExtractionIssue, stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onEntity?: (entity: ExtractedEntity) => Promise<void> | void;
      executionMode?: IngestExecutionMode;
      retainEntities?: boolean;
      retainIssues?: boolean;
    } = {},
  ): Promise<ExtractionBundle> {
    if (options.executionMode === "media_only") {
      throw new Error(
        'Execution mode "media_only" is Notubiz-only for now: OpenMeeting recordings are not published yet.',
      );
    }

    const retainEntities = options.retainEntities ?? true;
    const retainIssues = options.retainIssues ?? true;
    const meetings: MeetingEntity[] = [];
    const documents: DocumentEntity[] = [];
    const committees: CommitteeEntity[] = [];
    const issues: ExtractionIssue[] = [];
    let meetingCount = 0;
    let documentCount = 0;
    let cacheHits = 0;
    let downloadedCount = 0;
    let issueCount = 0;

    const currentStats = (): ExtractionBundle["stats"] => ({
      meeting_count: meetingCount,
      document_count: documentCount,
      cache_hits: cacheHits,
      downloaded_count: downloadedCount,
      issue_count: issueCount,
    });
    const registerIssue = async (issue: ExtractionIssue): Promise<void> => {
      issueCount += 1;
      if (retainIssues) issues.push(issue);
      await options.onIssue?.(issue, currentStats());
    };
    const bundle = (): ExtractionBundle => ({
      meetings,
      documents,
      committees,
      issues,
      stats: currentStats(),
    });

    const storage = await this.storageProvider();
    if (!storage) {
      await registerIssue({
        severity: "error",
        step: "list_events",
        message: "No object storage: published OpenMeeting meetings cannot be read",
      });
      return bundle();
    }

    const seenCommittees = new Set<string>();
    const pendingDocuments = new Map<string, DocumentEntity>();
    try {
      for await (const { key, meeting: published } of new PublishedMeetings(storage).list(
        source.key,
      )) {
        const day = amsterdamDay(published.start_date);
        if (day < dateFrom || day > dateTo) continue;
        try {
          const {
            meeting,
            documents: docs,
            committee,
          } = await normalizePublishedMeeting(source, published);
          if (committee && !seenCommittees.has(committee.id)) {
            seenCommittees.add(committee.id);
            if (retainEntities) committees.push(committee);
            await options.onEntity?.(committee);
          }
          meetingCount += 1;
          if (retainEntities) meetings.push(meeting);
          await options.onProgress?.(currentStats());
          await options.onEntity?.(meeting);
          for (const doc of docs) pendingDocuments.set(doc.id, doc);
        } catch (error) {
          await registerIssue({
            severity: "error",
            step: "get_meeting",
            entity_id: key,
            message: error instanceof Error ? error.message : "Published meeting could not be read",
          });
        }
      }
    } catch (error) {
      await registerIssue({
        severity: "error",
        step: "list_events",
        message: error instanceof Error ? error.message : "Failed to list published meetings",
      });
      return bundle();
    }

    const documentConcurrency = Number(
      Deno.env.get("WOOZI_DOCUMENT_CONCURRENCY") ?? `${DEFAULT_DOCUMENT_CONCURRENCY}`,
    );
    await mapLimit([...pendingDocuments.values()], documentConcurrency, async (document) => {
      try {
        const inline = !document.original_url ? document.md_text?.join("\n\n") : undefined;
        const materialized = inline
          ? await materializeInlineText(document, inline, storage)
          : await materializeDocument(document, {
              download: (doc) => downloadPublishedDocument(doc.original_url!, this.fetcher),
              storage,
              executionMode: options.executionMode,
            });
        for (const issue of materialized.issues) await registerIssue(issue);
        documentCount += 1;
        if (retainEntities) documents.push(materialized.document);
        if (materialized.cacheHit) cacheHits += 1;
        else if (document.original_url) downloadedCount += 1;
        await options.onProgress?.(currentStats());
        await options.onEntity?.(materialized.document);
      } catch (error) {
        await registerIssue({
          severity: "error",
          step: "download_document",
          entity_id: document.id,
          message: error instanceof Error ? error.message : "Document processing failed",
        });
      }
    });

    return bundle();
  }
}
