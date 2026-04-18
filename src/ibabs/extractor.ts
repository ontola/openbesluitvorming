import { materializeDocument } from "../documents/process.ts";
import { buildEntityCommitEvent } from "../events/entity_commit.ts";
import type {
  DocumentEntity,
  EntityCommitEvent,
  ExtractionBundle,
  ExtractionIssue,
  IbabsSourceDefinition,
  IngestExecutionMode,
  MeetingEntity,
  WooziEntity,
} from "../types.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import { normalizeIbabsDocuments, normalizeIbabsMeeting } from "./normalize.ts";
import { IbabsClient } from "./client.ts";
import { mapLimit } from "../util/map_limit.ts";

const DEFAULT_DOCUMENT_CONCURRENCY = 3;

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

export class IbabsMeetingExtractor {
  constructor(
    private readonly client = new IbabsClient(),
    private readonly storageProvider: () => Promise<ObjectStorageClient | undefined> = () =>
      ObjectStorageClient.fromEnvironment(),
  ) {}

  async extractForDateRange(
    source: IbabsSourceDefinition,
    dateFrom: string,
    dateTo: string,
    options: {
      onProgress?: (stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onIssue?: (issue: ExtractionIssue, stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onEntity?: (entity: MeetingEntity | DocumentEntity) => Promise<void> | void;
      executionMode?: IngestExecutionMode;
      retainEntities?: boolean;
      retainIssues?: boolean;
    } = {},
  ): Promise<ExtractionBundle> {
    const meetingTypes = await this.client.getMeetingTypes(source);
    const meetingTypeMap = new Map(
      meetingTypes.map((meetingType) => [
        meetingType.Id,
        meetingType.Description ?? meetingType.Meetingtype ?? meetingType.Id,
      ]),
    );
    const rawMeetings = await this.client.listMeetingsByDateRange(source, dateFrom, dateTo);
    const retainEntities = options.retainEntities ?? true;
    const retainIssues = options.retainIssues ?? true;
    const meetings: MeetingEntity[] = [];
    const documents: DocumentEntity[] = [];
    const issues: ExtractionIssue[] = [];
    let cacheHits = 0;
    let downloadedCount = 0;
    let meetingCount = 0;
    let documentCount = 0;
    let issueCount = 0;
    const storage = await this.storageProvider();

    const currentStats = (): ExtractionBundle["stats"] => ({
      meeting_count: meetingCount,
      document_count: documentCount,
      cache_hits: cacheHits,
      downloaded_count: downloadedCount,
      issue_count: issueCount,
    });

    const registerIssue = async (issue: ExtractionIssue): Promise<void> => {
      issueCount += 1;
      if (retainIssues) {
        issues.push(issue);
      }
      await options.onIssue?.(issue, currentStats());
    };

    const documentConcurrency = Number(
      Deno.env.get("WOOZI_DOCUMENT_CONCURRENCY") ?? `${DEFAULT_DOCUMENT_CONCURRENCY}`,
    );

    const documentsById = new Map<string, DocumentEntity>();

    for (const rawMeeting of rawMeetings) {
      const meeting = normalizeIbabsMeeting(source, rawMeeting, meetingTypeMap);
      meetingCount += 1;
      if (retainEntities) {
        meetings.push(meeting);
      }
      await options.onProgress?.(currentStats());
      await options.onEntity?.(meeting);

      for (const document of normalizeIbabsDocuments(source, meeting)) {
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
        documentCount += 1;
        if (retainEntities) {
          documents.push(materialized.document);
        }
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

    return {
      meetings,
      documents,
      issues,
      stats: currentStats(),
    };
  }

  async extractCommitEventsForDateRange(
    source: IbabsSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<EntityCommitEvent<WooziEntity>>> {
    const bundle = await this.extractForDateRange(source, dateFrom, dateTo);
    const entities = [...bundle.meetings, ...bundle.documents];
    return await Promise.all(entities.map((entity) => buildEntityCommitEvent(entity)));
  }
}
