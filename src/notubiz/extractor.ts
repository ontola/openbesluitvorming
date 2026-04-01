import { materializeDocument } from "../documents/process.ts";
import { NotubizClient } from "./client.ts";
import { buildEntityCommitEvent } from "../events/entity_commit.ts";
import { canonicalMeetingId } from "../ids.ts";
import { normalizeNotubizDocuments, normalizeNotubizMeeting } from "./normalize.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import type {
  EntityCommitEvent,
  DocumentEntity,
  ExtractionIssue,
  ExtractionBundle,
  MeetingEntity,
  NotubizSourceDefinition,
  WooziEntity,
  IngestExecutionMode,
} from "../types.ts";

type NotubizEventsResponse = {
  events?: unknown[];
  pagination?: {
    has_more_pages?: boolean;
  };
};

type NotubizMeetingResponse = {
  meeting?: unknown;
};

const DEFAULT_MEETING_CONCURRENCY = 6;
const DEFAULT_DOCUMENT_CONCURRENCY = 3;

async function mapLimit<TInput, TOutput>(
  items: TInput[],
  limit: number,
  task: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = Array.from({ length: items.length }) as TOutput[];
  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await task(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}

function isSkippableMeetingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Request failed 401") || error.message.includes("Request failed 403")
  );
}

function issueStepForDocumentError(error: unknown): ExtractionIssue["step"] {
  if (!(error instanceof Error)) {
    return "download_document";
  }

  if (
    error.message.includes("transmutation failed") ||
    error.message.includes("Rust transmutation CLI not found") ||
    error.message.includes("Office document extraction is not supported yet") ||
    error.message.includes("PDF parsing error")
  ) {
    return "extract_text";
  }

  return "download_document";
}

export class NotubizMeetingExtractor {
  constructor(
    private readonly client = new NotubizClient(),
    private readonly storageProvider: () => Promise<ObjectStorageClient | undefined> = () =>
      ObjectStorageClient.fromEnvironment(),
  ) {}

  async extractForDateRange(
    source: NotubizSourceDefinition,
    dateFrom: string,
    dateTo: string,
    options: {
      onProgress?: (stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onIssue?: (issue: ExtractionIssue, stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onEntity?: (entity: MeetingEntity | DocumentEntity) => Promise<void> | void;
      executionMode?: IngestExecutionMode;
    } = {},
  ): Promise<ExtractionBundle> {
    const organizationAttributes = await this.client.getOrganizationAttributes(
      source.notubizOrganizationId,
    );

    const meetings: MeetingEntity[] = [];
    const documents: DocumentEntity[] = [];
    const issues: ExtractionIssue[] = [];
    let cacheHits = 0;
    let downloadedCount = 0;
    let page = 1;
    const storage = await this.storageProvider();
    const meetingConcurrency = Number(
      Deno.env.get("WOOZI_MEETING_CONCURRENCY") ?? `${DEFAULT_MEETING_CONCURRENCY}`,
    );
    const documentConcurrency = Number(
      Deno.env.get("WOOZI_DOCUMENT_CONCURRENCY") ?? `${DEFAULT_DOCUMENT_CONCURRENCY}`,
    );

    const currentStats = (): ExtractionBundle["stats"] => ({
      meeting_count: meetings.length,
      document_count: documents.length,
      cache_hits: cacheHits,
      downloaded_count: downloadedCount,
      issue_count: issues.length,
    });

    const registerIssue = async (issue: ExtractionIssue): Promise<void> => {
      issues.push(issue);
      await options.onIssue?.(issue, currentStats());
    };

    while (true) {
      const eventPage = (await this.client.listEvents(
        source.notubizOrganizationId,
        dateFrom,
        dateTo,
        page,
      )) as NotubizEventsResponse;

      const events = Array.isArray(eventPage.events) ? eventPage.events : [];
      if (events.length === 0) {
        break;
      }

      const publicMeetingIds = events
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object"),
        )
        .filter((eventRecord) => eventRecord.permission_group === "public")
        .map((eventRecord) => eventRecord.id)
        .filter((meetingId): meetingId is number => typeof meetingId === "number");

      const pageMeetings = (
        await mapLimit(publicMeetingIds, meetingConcurrency, async (meetingId) => {
          try {
            const meetingResponse = (await this.client.getMeeting(
              meetingId,
            )) as NotubizMeetingResponse;
            if (!meetingResponse.meeting) {
              return null;
            }
            const meeting = normalizeNotubizMeeting(
              source,
              organizationAttributes,
              meetingResponse.meeting,
            );
            meetings.push(meeting);
            await options.onProgress?.(currentStats());
            await options.onEntity?.(meeting);
            return meeting;
          } catch (error) {
            if (isSkippableMeetingError(error)) {
              await registerIssue({
                severity: "warning",
                step: "get_meeting",
                entity_id: canonicalMeetingId(source, meetingId),
                message: error instanceof Error ? error.message : "Meeting detail not accessible",
              });
              return null;
            }
            throw error;
          }
        })
      ).filter((meeting): meeting is NonNullable<typeof meeting> => Boolean(meeting));

      const documentsById = new Map<string, ReturnType<typeof normalizeNotubizDocuments>[number]>();
      for (const meeting of pageMeetings) {
        for (const document of normalizeNotubizDocuments(source, meeting)) {
          documentsById.set(document.id, document);
        }
      }

      await mapLimit([...documentsById.values()], documentConcurrency, async (document) => {
        try {
          const materialized = await materializeDocument(document, {
            download: (documentEntity) => this.client.downloadDocument(documentEntity),
            storage,
            executionMode: options.executionMode,
          });
          for (const issue of materialized.issues) {
            await registerIssue(issue);
          }
          documents.push(materialized.document);
          if (materialized.cacheHit) {
            cacheHits += 1;
          } else {
            downloadedCount += 1;
          }
          await options.onProgress?.(currentStats());
          await options.onEntity?.(materialized.document);
        } catch (error) {
          await registerIssue({
            severity: "error",
            step: issueStepForDocumentError(error),
            entity_id: document.id,
            message: error instanceof Error ? error.message : "Document processing failed",
          });
        }
      });

      if (!eventPage.pagination?.has_more_pages) {
        break;
      }

      page += 1;
    }

    return {
      meetings,
      documents,
      issues,
      stats: currentStats(),
    };
  }

  async extractCommitEventsForDateRange(
    source: NotubizSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<EntityCommitEvent<WooziEntity>>> {
    const bundle = await this.extractForDateRange(source, dateFrom, dateTo);
    const entities = [...bundle.meetings, ...bundle.documents];
    return await Promise.all(entities.map((entity) => buildEntityCommitEvent(entity)));
  }
}
