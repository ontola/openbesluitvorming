import { materializeDocument } from "../documents/process.ts";
import { buildEntityCommitEvent } from "../events/entity_commit.ts";
import type {
  DocumentEntity,
  EntityCommitEvent,
  ExtractionBundle,
  ExtractionIssue,
  IbabsSourceDefinition,
  MeetingEntity,
  WooziEntity,
} from "../types.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import { normalizeIbabsDocuments, normalizeIbabsMeeting } from "./normalize.ts";
import { IbabsClient } from "./client.ts";

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
    const meetings: MeetingEntity[] = [];
    const documents: DocumentEntity[] = [];
    const issues: ExtractionIssue[] = [];
    let cacheHits = 0;
    let downloadedCount = 0;
    const storage = await this.storageProvider();

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

    const documentsById = new Map<string, DocumentEntity>();

    for (const rawMeeting of rawMeetings) {
      const meeting = normalizeIbabsMeeting(source, rawMeeting, meetingTypeMap);
      meetings.push(meeting);
      await options.onProgress?.(currentStats());

      for (const document of normalizeIbabsDocuments(source, meeting)) {
        documentsById.set(document.id, document);
      }
    }

    for (const document of documentsById.values()) {
      try {
        const materialized = await materializeDocument(document, {
          download: (documentEntity) => this.client.downloadDocument(documentEntity),
          storage,
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
      } catch (error) {
        await registerIssue({
          severity: "error",
          step: issueStepForDocumentError(error),
          entity_id: document.id,
          message: error instanceof Error ? error.message : "Document processing failed",
        });
      }
    }

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
