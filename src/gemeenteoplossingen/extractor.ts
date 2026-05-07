import { materializeDocument } from "../documents/process.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import type {
  CommitteeEntity,
  DocumentEntity,
  ExtractionBundle,
  ExtractionIssue,
  GemeenteOplossingenSourceDefinition,
  IngestExecutionMode,
  MeetingEntity,
  PartyEntity,
  PersonEntity,
} from "../types.ts";
import { AllmanakClient } from "../allmanak/client.ts";
import { normalizeAllmanakParties, normalizeAllmanakPersons } from "../allmanak/normalize.ts";
import { GemeenteOplossingenClient } from "./client.ts";
import { normalizeGoCommittee, normalizeGoDocuments, normalizeGoMeeting } from "./normalize.ts";
import { mapLimit } from "../util/map_limit.ts";

const DEFAULT_MEETING_CONCURRENCY = 6;
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

export class GemeenteOplossingenExtractor {
  constructor(
    private readonly clientFactory: (source: GemeenteOplossingenSourceDefinition) => GemeenteOplossingenClient =
      (source) => new GemeenteOplossingenClient(source.baseUrl, source.apiVersion ?? "v1"),
    private readonly allmanak = new AllmanakClient("v1"),
    private readonly storageProvider: () => Promise<ObjectStorageClient | undefined> = () =>
      ObjectStorageClient.fromEnvironment(),
  ) {}

  async extractForDateRange(
    source: GemeenteOplossingenSourceDefinition,
    dateFrom: string,
    dateTo: string,
    options: {
      onProgress?: (stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onIssue?: (issue: ExtractionIssue, stats: ExtractionBundle["stats"]) => Promise<void> | void;
      onEntity?: (
        entity: MeetingEntity | DocumentEntity | CommitteeEntity | PartyEntity | PersonEntity,
      ) => Promise<void> | void;
      executionMode?: IngestExecutionMode;
      retainEntities?: boolean;
      retainIssues?: boolean;
    } = {},
  ): Promise<ExtractionBundle> {
    const retainEntities = options.retainEntities ?? true;
    const retainIssues = options.retainIssues ?? true;

    const meetings: MeetingEntity[] = [];
    const documents: DocumentEntity[] = [];
    const committees: CommitteeEntity[] = [];
    const parties: PartyEntity[] = [];
    const persons: PersonEntity[] = [];
    const issues: ExtractionIssue[] = [];

    let cacheHits = 0;
    let downloadedCount = 0;
    let meetingCount = 0;
    let documentCount = 0;
    let issueCount = 0;

    const storage = await this.storageProvider();
    const meetingConcurrency = Number(
      Deno.env.get("WOOZI_MEETING_CONCURRENCY") ?? `${DEFAULT_MEETING_CONCURRENCY}`,
    );
    const documentConcurrency = Number(
      Deno.env.get("WOOZI_DOCUMENT_CONCURRENCY") ?? `${DEFAULT_DOCUMENT_CONCURRENCY}`,
    );

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

    const client = this.clientFactory(source);

    // 1) Committees (GO DMUs)
    try {
      const rawCommittees = await client.listCommittees();
      for (const raw of rawCommittees) {
        const entity = normalizeGoCommittee(source, raw);
        if (retainEntities) {
          committees.push(entity);
        }
        await options.onEntity?.(entity);
      }
    } catch (error) {
      await registerIssue({
        severity: "error",
        step: "list_events",
        message: error instanceof Error ? error.message : "Failed to list committees",
      });
    }

    // 2) Parties + Persons (Allmanak)
    try {
      const rawSeats = await this.allmanak.getCouncilParties(source.allmanakId);
      const partyEntities = normalizeAllmanakParties(source, rawSeats);
      for (const party of partyEntities) {
        if (retainEntities) {
          parties.push(party);
        }
        await options.onEntity?.(party);
      }
    } catch (error) {
      await registerIssue({
        severity: "warning",
        step: "list_events",
        message: error instanceof Error ? error.message : "Failed to fetch parties from Allmanak",
      });
    }

    try {
      const rawPeople = await this.allmanak.getCouncilMembers(source.allmanakId);
      const personEntities = normalizeAllmanakPersons(source, rawPeople);
      for (const person of personEntities) {
        if (retainEntities) {
          persons.push(person);
        }
        await options.onEntity?.(person);
      }
    } catch (error) {
      await registerIssue({
        severity: "warning",
        step: "list_events",
        message: error instanceof Error ? error.message : "Failed to fetch persons from Allmanak",
      });
    }

    // 3) Meetings + Documents (GO)
    const rawMeetings = await client.listMeetingsByDateRange(dateFrom, dateTo);
    const normalizedMeetings = rawMeetings.map((meeting) => normalizeGoMeeting(source, meeting));

    const meetingDocs: DocumentEntity[] = [];
    await mapLimit(normalizedMeetings, meetingConcurrency, async (meeting) => {
      meetingCount += 1;
      if (retainEntities) {
        meetings.push(meeting);
      }
      await options.onProgress?.(currentStats());
      await options.onEntity?.(meeting);
      for (const doc of normalizeGoDocuments(source, meeting)) {
        meetingDocs.push(doc);
      }
    });

    const docsById = new Map<string, DocumentEntity>();
    for (const doc of meetingDocs) {
      docsById.set(doc.id, doc);
    }

    await mapLimit([...docsById.values()], documentConcurrency, async (document) => {
      try {
        const materialized = await materializeDocument(document, {
          download: async (doc) => {
            if (!doc.original_url) {
              throw new Error(`GO document is missing original_url (${doc.id})`);
            }
            const response = await fetch(doc.original_url, {
              signal: AbortSignal.timeout(90_000),
              headers: { "user-agent": "woozi/0.1", accept: "*/*" },
            });
            if (!response.ok) {
              throw new Error(`Request failed ${response.status} for ${doc.original_url}`);
            }
            return new Uint8Array(await response.arrayBuffer());
          },
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
      committees,
      parties,
      persons,
      issues,
      stats: currentStats(),
    };
  }
}

