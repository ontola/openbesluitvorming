import { materializeDocument } from "../documents/process.ts";
import { NotubizClient } from "./client.ts";
import { buildEntityCommitEvent } from "../events/entity_commit.ts";
import { normalizeNotubizDocuments, normalizeNotubizMeeting } from "./normalize.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import type {
  EntityCommitEvent,
  ExtractionIssue,
  ExtractionBundle,
  NotubizSourceDefinition,
  WooziEntity,
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

function isSkippableMeetingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Request failed 401") || error.message.includes("Request failed 403")
  );
}

export class NotubizMeetingExtractor {
  constructor(private readonly client = new NotubizClient()) {}

  async extractForDateRange(
    source: NotubizSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<ExtractionBundle> {
    const organizationAttributes = await this.client.getOrganizationAttributes(
      source.notubizOrganizationId,
    );

    const meetings = [];
    const documents = [];
    const issues: ExtractionIssue[] = [];
    let cacheHits = 0;
    let downloadedCount = 0;
    let page = 1;
    const storage = await ObjectStorageClient.fromEnvironment();

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

      for (const item of events) {
        if (!item || typeof item !== "object") continue;
        const eventRecord = item as Record<string, unknown>;
        if (eventRecord.permission_group !== "public") {
          continue;
        }

        const meetingId = eventRecord.id;
        if (typeof meetingId !== "number") {
          continue;
        }

        let meetingResponse: NotubizMeetingResponse;
        try {
          meetingResponse = (await this.client.getMeeting(meetingId)) as NotubizMeetingResponse;
        } catch (error) {
          if (isSkippableMeetingError(error)) {
            issues.push({
              severity: "warning",
              step: "get_meeting",
              entity_id: `meeting:notubiz:${source.key}:${meetingId}`,
              message: error instanceof Error ? error.message : "Meeting detail not accessible",
            });
            continue;
          }
          throw error;
        }
        if (!meetingResponse.meeting) {
          continue;
        }

        meetings.push(
          normalizeNotubizMeeting(source, organizationAttributes, meetingResponse.meeting),
        );
        const meeting = meetings[meetings.length - 1];
        const extractedDocuments = normalizeNotubizDocuments(source, meeting);
        for (const document of extractedDocuments) {
          try {
            const materialized = await materializeDocument(document, {
              download: (url) => this.client.downloadDocument(url),
              storage,
            });
            documents.push(materialized.document);
            if (materialized.cacheHit) {
              cacheHits += 1;
            } else {
              downloadedCount += 1;
            }
          } catch (error) {
            issues.push({
              severity: "error",
              step: "download_document",
              entity_id: document.id,
              message: error instanceof Error ? error.message : "Document processing failed",
            });
          }
        }
      }

      if (!eventPage.pagination?.has_more_pages) {
        break;
      }

      page += 1;
    }

    return {
      meetings,
      documents,
      issues,
      stats: {
        meeting_count: meetings.length,
        document_count: documents.length,
        cache_hits: cacheHits,
        downloaded_count: downloadedCount,
        issue_count: issues.length,
      },
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
