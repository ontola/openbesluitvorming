import { materializeDocument } from "../documents/process.ts";
import { NotubizClient } from "./client.ts";
import { buildEntityCommitEvent } from "../events/entity_commit.ts";
import { canonicalMeetingId } from "../ids.ts";
import { normalizeNotubizDocuments, normalizeNotubizMeeting } from "./normalize.ts";
import {
  isMotionModule,
  normalizeNotubizMotion,
  normalizeNotubizMotionDocuments,
} from "./motions.ts";
import { normalizeNotubizRecording } from "./recordings.ts";
import { storeTranscript } from "../recordings/storage.ts";
import { MeetingIndex } from "../motions/normalize.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import { mapLimit } from "../util/map_limit.ts";
import type {
  EntityCommitEvent,
  DocumentEntity,
  ExtractedEntity,
  ExtractionIssue,
  ExtractionBundle,
  MeetingEntity,
  MotionEntity,
  NotubizModule,
  NotubizModuleItem,
  NotubizSourceDefinition,
  RecordingEntity,
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
  // Notubiz reports failures as HTTP 200 with an error body rather than a
  // 4xx/5xx, e.g. {"message":"No rights to see this meeting","error_code":...}
  // for a meeting whose permission_group is not public. fetchJson therefore
  // never throws for these, so they have to be recognised from the payload.
  message?: unknown;
  error_code?: unknown;
};

const DEFAULT_MEETING_CONCURRENCY = 6;
const DEFAULT_DOCUMENT_CONCURRENCY = 3;

function isSkippableMeetingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Request failed 401") || error.message.includes("Request failed 403")
  );
}

/** Human-readable reason for a meeting response that carries no `meeting`.
 * Notubiz signals these as HTTP 200 with an error body, so the reason is only
 * available from the payload. */
export function describeMeetingResponseError(response: {
  message?: unknown;
  error_code?: unknown;
}): string {
  const message = typeof response.message === "string" ? response.message.trim() : "";
  const code =
    typeof response.error_code === "number" || typeof response.error_code === "string"
      ? String(response.error_code)
      : "";
  if (message && code) {
    return `${message} (error_code ${code})`;
  }
  if (message) {
    return message;
  }
  if (code) {
    return `error_code ${code}`;
  }
  return "no error detail in response";
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
      onEntity?: (entity: ExtractedEntity) => Promise<void> | void;
      executionMode?: IngestExecutionMode;
      retainEntities?: boolean;
      retainIssues?: boolean;
    } = {},
  ): Promise<ExtractionBundle> {
    // Skips the document pass entirely: a media backfill runs over history we
    // already hold, and re-downloading and re-extracting those PDFs is by far
    // the expensive part of a full run. What it still needs is the events list
    // (for the meeting ids) and the meeting detail, because the agenda offsets
    // that place chapters on the recording's timeline live in that response.
    const mediaOnly = options.executionMode === "media_only";

    if (options.executionMode === "motions_only") {
      // Notubiz motions reference their agenda item by id, and the only way we
      // resolve that to a meeting is from meetings imported in the same run.
      // Skipping the meeting pass would produce motions that silently link to
      // nothing, which is worse than not importing them.
      throw new Error(
        'Execution mode "motions_only" is iBabs-only: Notubiz motions link to a ' +
          "meeting through agenda items collected by the meeting pass.",
      );
    }

    const organizationAttributes = await this.client.getOrganizationAttributes(
      source.notubizOrganizationId,
    );

    const retainEntities = options.retainEntities ?? true;
    const retainIssues = options.retainIssues ?? true;
    const meetings: MeetingEntity[] = [];
    const documents: DocumentEntity[] = [];
    const motions: MotionEntity[] = [];
    const recordings: RecordingEntity[] = [];
    const issues: ExtractionIssue[] = [];
    let cacheHits = 0;
    let downloadedCount = 0;
    let meetingCount = 0;
    let documentCount = 0;
    let motionCount = 0;
    let recordingCount = 0;
    let issueCount = 0;
    let page = 1;
    const storage = await this.storageProvider();
    const meetingIndex = new MeetingIndex();
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
      motion_count: motionCount,
      recording_count: recordingCount,
    });

    const registerIssue = async (issue: ExtractionIssue): Promise<void> => {
      issueCount += 1;
      if (retainIssues) {
        issues.push(issue);
      }
      await options.onIssue?.(issue, currentStats());
    };

    while (true) {
      const tPage = performance.now();
      const eventPage = (await this.client.listEvents(
        source.notubizOrganizationId,
        dateFrom,
        dateTo,
        page,
      )) as NotubizEventsResponse;

      const events = Array.isArray(eventPage.events) ? eventPage.events : [];
      console.log(
        `[timing] ${source.key} api=listEvents page=${page} events=${events.length} ${Math.round(performance.now() - tPage)}ms`,
      );
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
              // Never drop this silently. A meeting that yields no detail is
              // a document-coverage hole, and reporting nothing made runs
              // finish "succeeded" with issue_count 0 while contributing no
              // documents at all -- indistinguishable from an organisation
              // that genuinely published none. Den Haag looked like that bug
              // for a while (2026-08-02) before measurement showed its
              // documents really are absent from the API.
              const detail = describeMeetingResponseError(meetingResponse);
              await registerIssue({
                severity: "warning",
                step: "get_meeting",
                entity_id: canonicalMeetingId(source, meetingId),
                message: `Meeting detail returned no meeting: ${detail}`,
              });
              return null;
            }
            const meeting = normalizeNotubizMeeting(
              source,
              organizationAttributes,
              meetingResponse.meeting,
            );
            meetingCount += 1;
            meetingIndex.add(meeting);
            if (retainEntities) {
              meetings.push(meeting);
            }
            await options.onProgress?.(currentStats());
            // A media backfill runs over meetings that were imported long ago.
            // Re-emitting them would rewrite hundreds of thousands of unchanged
            // entities for nothing; the recording only needs the meeting's id,
            // which it already has. `meeting_count` still counts what was
            // scanned, so the run reports the work it actually did.
            if (!mediaOnly) {
              await options.onEntity?.(meeting);
            }

            await this.extractRecordings(source, meeting, meetingResponse.meeting, {
              storage,
              registerIssue,
              onRecording: async (recording) => {
                recordingCount += 1;
                if (retainEntities) {
                  recordings.push(recording);
                }
                await options.onProgress?.(currentStats());
                await options.onEntity?.(recording);
              },
            });

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
      if (!mediaOnly) {
        for (const meeting of pageMeetings) {
          for (const document of normalizeNotubizDocuments(source, meeting)) {
            documentsById.set(document.id, document);
          }
        }
      }
      const tDocs = performance.now();

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

      console.log(
        `[timing] ${source.key} page=${page} meetings=${pageMeetings.length} docs=${documentsById.size} docs_time=${Math.round(performance.now() - tDocs)}ms`,
      );

      if (!eventPage.pagination?.has_more_pages) {
        break;
      }

      page += 1;
    }

    // Motions run once all pages are in, so every meeting they could reference
    // is already in the index. A media backfill skips them: it is there for the
    // recordings, and the registries were already imported by the run that
    // brought in these meetings.
    if (!mediaOnly) {
      await this.extractMotions(source, dateFrom, dateTo, {
        meetingIndex,
        registerIssue,
        onMotion: async (motion, motionDocuments) => {
          motionCount += 1;
          if (retainEntities) {
            motions.push(motion);
          }
          await options.onProgress?.(currentStats());
          await options.onEntity?.(motion);

          await mapLimit(motionDocuments, documentConcurrency, async (document) => {
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
        },
      });
    }

    return {
      meetings,
      documents,
      motions,
      recordings,
      issues,
      stats: currentStats(),
    };
  }

  /** Import the video/audio registration of one meeting, with its transcript.
   *
   * Reported but never fatal, like motions: roughly half the meetings are never
   * streamed, and a meeting is worth importing either way. The chapters come
   * from `agenda_items[].start_offset` in the detail response we already have,
   * so they cost no extra call. */
  private async extractRecordings(
    source: NotubizSourceDefinition,
    meeting: MeetingEntity,
    rawMeeting: unknown,
    context: {
      storage?: ObjectStorageClient;
      registerIssue: (issue: ExtractionIssue) => Promise<void>;
      onRecording: (recording: RecordingEntity) => Promise<void>;
    },
  ): Promise<void> {
    const meetingId = Number(meeting.id.split(":").at(-1));
    if (!Number.isFinite(meetingId)) {
      return;
    }

    let media: Awaited<ReturnType<NotubizClient["listMedia"]>>;
    try {
      media = await this.client.listMedia(meetingId);
    } catch (error) {
      await context.registerIssue({
        severity: "warning",
        step: "list_media",
        entity_id: meeting.id,
        message: `Media unavailable for ${meeting.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    for (const item of media) {
      let transcript: string | undefined;
      if (item.subtitles_url) {
        try {
          transcript = await this.client.downloadSubtitles(item);
        } catch (error) {
          // A missing transcript still leaves a playable recording with its
          // agenda timeline, so this degrades rather than skips.
          await context.registerIssue({
            severity: "warning",
            step: "download_transcript",
            entity_id: meeting.id,
            message: `Transcript download failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }

      const recording = normalizeNotubizRecording(source, meeting, rawMeeting, item, {
        transcript,
      });

      try {
        await context.onRecording(
          await storeTranscript(recording, {
            storage: context.storage,
            rawTranscript: transcript,
            rawExtension: "srt",
          }),
        );
      } catch (error) {
        await context.registerIssue({
          severity: "warning",
          step: "upload_s3",
          entity_id: recording.id,
          message: `Storing the transcript failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        await context.onRecording(recording);
      }
    }
  }

  /** Import moties/amendementen from the organisation's registry modules.
   *
   * Reported but never fatal: not every organisation has a moties module, and
   * meetings are the primary product of a run. */
  private async extractMotions(
    source: NotubizSourceDefinition,
    dateFrom: string,
    dateTo: string,
    context: {
      meetingIndex: MeetingIndex;
      registerIssue: (issue: ExtractionIssue) => Promise<void>;
      onMotion: (motion: MotionEntity, documents: DocumentEntity[]) => Promise<void>;
    },
  ): Promise<void> {
    let modules: NotubizModule[];
    try {
      modules = await this.client.listModules(source.notubizOrganizationId);
    } catch (error) {
      await context.registerIssue({
        severity: "warning",
        step: "list_motions",
        entity_id: source.key,
        message: `Notubiz modules unavailable for ${source.key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    for (const module of modules.filter(isMotionModule)) {
      let items: NotubizModuleItem[];
      try {
        items = await this.client.listModuleItems(
          source.notubizOrganizationId,
          module.id,
          dateFrom,
          dateTo,
        );
      } catch (error) {
        await context.registerIssue({
          severity: "warning",
          step: "list_motions",
          entity_id: source.key,
          message: `Notubiz module "${module.name}" failed for ${source.key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }

      for (const item of items) {
        const motion = normalizeNotubizMotion(source, module, item, context.meetingIndex);
        await context.onMotion(motion, normalizeNotubizMotionDocuments(source, motion, item));
      }
    }
  }

  async extractCommitEventsForDateRange(
    source: NotubizSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<EntityCommitEvent<WooziEntity>>> {
    const bundle = await this.extractForDateRange(source, dateFrom, dateTo);
    const entities = [
      ...bundle.meetings,
      ...bundle.documents,
      ...(bundle.motions ?? []),
      ...(bundle.recordings ?? []),
    ];
    return await Promise.all(entities.map((entity) => buildEntityCommitEvent(entity)));
  }
}
