import { materializeDocument } from "../documents/process.ts";
import { buildEntityCommitEvent } from "../events/entity_commit.ts";
import type {
  DocumentEntity,
  EntityCommitEvent,
  ExtractedEntity,
  ExtractionBundle,
  ExtractionIssue,
  IbabsList,
  IbabsListEntryBase,
  IbabsMeeting,
  IbabsSourceDefinition,
  IngestExecutionMode,
  MeetingEntity,
  MotionEntity,
  WooziEntity,
} from "../types.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import {
  normalizeIbabsDocuments,
  normalizeIbabsMeeting,
  normalizeIbabsMotion,
  normalizeIbabsMotionDocuments,
} from "./normalize.ts";
import { MeetingIndex, parseAgendaPointReference } from "../motions/normalize.ts";
import { IbabsClient } from "./client.ts";
import { mapLimit } from "../util/map_limit.ts";
import { splitDateRange } from "../util/date_range.ts";

const DEFAULT_DOCUMENT_CONCURRENCY = 3;
const DEFAULT_DATE_CHUNK_MONTHS = 6;
/** Registries worth importing. Toezeggingen and schriftelijke vragen carry no
 * outcome, so they're left out until there's a reason to include them. */
const MOTION_LIST_PATTERN = /moties?|amendement|stemming/i;
/** Ceiling on list entries fetched per run. Each one costs two SOAP calls, so
 * an unexpectedly wide window shouldn't be able to run for hours. Overruns are
 * reported as an issue rather than silently dropped. */
const DEFAULT_MOTION_LIMIT = 750;
/** Concurrency for the motion pass, deliberately below the document one.
 *
 * Motions are pure SOAP traffic against a single throttled endpoint, where
 * documents are downloads spread over api1.ibabs.eu. Reusing the document
 * setting meant 20 parallel runs each firing 3 concurrent SOAP calls; iBabs
 * answered with 403s and 203 motions were skipped across one batch. */
const DEFAULT_MOTION_CONCURRENCY = 2;
// Some sitenames (e.g. Rotterdam) return SOAP payloads large enough to exceed
// the 90s client timeout at 6-month chunks. When that happens we recursively
// halve the chunk; this floor stops the recursion if something else is wrong.
const MIN_ADAPTIVE_CHUNK_DAYS = 14;

function rangeDays(from: string, to: string): number {
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

function isSoapTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const msg = error.message.toLowerCase();
  return msg.includes("signal timed out") || msg.includes("timed out");
}

async function listMeetingsAdaptive(
  client: IbabsClient,
  source: IbabsSourceDefinition,
  from: string,
  to: string,
  onSplit: (from: string, to: string) => Promise<void>,
): Promise<IbabsMeeting[]> {
  try {
    return await client.listMeetingsByDateRange(source, from, to);
  } catch (error) {
    if (!isSoapTimeout(error) || rangeDays(from, to) < MIN_ADAPTIVE_CHUNK_DAYS * 2) {
      throw error;
    }
    const fromMs = new Date(`${from}T00:00:00Z`).getTime();
    const toMs = new Date(`${to}T00:00:00Z`).getTime();
    const midMs = fromMs + Math.floor((toMs - fromMs) / 2);
    const midDate = new Date(midMs).toISOString().slice(0, 10);
    const beforeMid = new Date(midMs - 86_400_000).toISOString().slice(0, 10);
    await onSplit(from, to);
    const left = await listMeetingsAdaptive(client, source, from, beforeMid, onSplit);
    const right = await listMeetingsAdaptive(client, source, midDate, to, onSplit);
    return [...left, ...right];
  }
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

/** Is this entry's last change inside the run window?
 *
 * `GetListsEntriesByFilterRequest` only takes a lower bound, so a historical
 * backfill window would otherwise pull the entire registry up to today. Using
 * the supplier's own `MutationDate` as the upper bound keeps each run to what
 * actually changed in its period; a motion edited later is picked up by the
 * run covering that later date. */
function isEntryInWindow(mutationDate: string | undefined, from: string, to: string): boolean {
  if (!mutationDate) {
    // No MutationDate means we can't place it in time. Import it rather than
    // drop it — a duplicate commit is harmless, a missing motion isn't.
    return true;
  }
  const date = mutationDate.slice(0, 10);
  return date >= from && date <= to;
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
      onEntity?: (entity: ExtractedEntity) => Promise<void> | void;
      executionMode?: IngestExecutionMode;
      retainEntities?: boolean;
      retainIssues?: boolean;
    } = {},
  ): Promise<ExtractionBundle> {
    if (options.executionMode === "media_only") {
      // Silence here would be worse than an error: the mode would fall through
      // to a full import and re-download every document of a source that was
      // only meant to be scanned for recordings.
      throw new Error(
        'Execution mode "media_only" is Notubiz-only for now: iBabs recordings are not implemented.',
      );
    }

    const meetingTypeMap = new Map<string, string>();
    const retainEntities = options.retainEntities ?? true;
    const retainIssues = options.retainIssues ?? true;
    const meetings: MeetingEntity[] = [];
    const documents: DocumentEntity[] = [];
    const motions: MotionEntity[] = [];
    const issues: ExtractionIssue[] = [];
    let cacheHits = 0;
    let downloadedCount = 0;
    let meetingCount = 0;
    let documentCount = 0;
    let motionCount = 0;
    let issueCount = 0;
    const storage = await this.storageProvider();
    const meetingIndex = new MeetingIndex();

    const currentStats = (): ExtractionBundle["stats"] => ({
      meeting_count: meetingCount,
      document_count: documentCount,
      cache_hits: cacheHits,
      downloaded_count: downloadedCount,
      issue_count: issueCount,
      motion_count: motionCount,
    });

    const registerIssue = async (issue: ExtractionIssue): Promise<void> => {
      issueCount += 1;
      if (retainIssues) {
        issues.push(issue);
      }
      await options.onIssue?.(issue, currentStats());
    };

    // Meeting types name every meeting, so this is the first call of a run —
    // and it used to be the only unguarded one. A throttle here killed whole
    // sources outright (berkelland, bergen op zoom, 2026-08-04).
    //
    // How bad losing it is depends on the mode, so they diverge. In a full run
    // the map supplies each meeting's name; continuing would write hundreds of
    // meetings called "Vergadering <date>", and bad names are worse than a
    // retryable failure. In motions_only nothing is named from it — it only
    // sharpens which meeting a motion links to, and MeetingIndex already falls
    // back to matching within the same day.
    try {
      for (const meetingType of await this.client.getMeetingTypes(source)) {
        meetingTypeMap.set(
          meetingType.Id,
          meetingType.Description ?? meetingType.Meetingtype ?? meetingType.Id,
        );
      }
    } catch (error) {
      if (options.executionMode !== "motions_only") {
        throw error;
      }
      await registerIssue({
        severity: "warning",
        step: "list_motions",
        entity_id: source.key,
        message:
          `iBabs GetMeetingtypes failed for ${source.ibabsSitename}; continuing without ` +
          `meeting-type names, so motion links fall back to same-day matching: ${
            error instanceof Error ? error.message : String(error)
          }`,
      });
    }

    const documentConcurrency = Number(
      Deno.env.get("WOOZI_DOCUMENT_CONCURRENCY") ?? `${DEFAULT_DOCUMENT_CONCURRENCY}`,
    );
    const motionConcurrency = Number(
      Deno.env.get("WOOZI_IBABS_MOTION_CONCURRENCY") ?? `${DEFAULT_MOTION_CONCURRENCY}`,
    );
    const chunkMonths = Number(
      Deno.env.get("WOOZI_IBABS_DATE_CHUNK_MONTHS") ?? `${DEFAULT_DATE_CHUNK_MONTHS}`,
    );

    // Motions-only skips the meeting and document pass entirely. Linking still
    // works: extractMotions fetches the meeting day each motion references, so
    // it builds exactly the slice of the index it needs instead of relying on
    // meetings this run happened to import.
    const chunks =
      options.executionMode === "motions_only" ? [] : splitDateRange(dateFrom, dateTo, chunkMonths);

    for (const [chunkFrom, chunkTo] of chunks) {
      const rawMeetings = await listMeetingsAdaptive(
        this.client,
        source,
        chunkFrom,
        chunkTo,
        async (splitFrom, splitTo) => {
          await registerIssue({
            severity: "warning",
            step: "list_events",
            entity_id: source.key,
            message: `iBabs SOAP timed out for ${source.ibabsSitename} ${splitFrom}..${splitTo}; halving chunk and retrying`,
          });
        },
      );
      const documentsById = new Map<string, DocumentEntity>();

      for (const rawMeeting of rawMeetings) {
        const meeting = normalizeIbabsMeeting(source, rawMeeting, meetingTypeMap);
        meetingCount += 1;
        meetingIndex.add(meeting);
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
    }

    // Motions run after every chunk so the meeting index covers the whole
    // window — a motion's agenda reference may point at a meeting from an
    // earlier chunk than the one it was mutated in.
    await this.extractMotions(source, dateFrom, dateTo, {
      meetingIndex,
      meetingTypes: meetingTypeMap,
      concurrency: motionConcurrency,
      registerIssue,
      onMotion: async (motion, motionDocuments) => {
        motionCount += 1;
        if (retainEntities) {
          motions.push(motion);
        }
        await options.onProgress?.(currentStats());
        await options.onEntity?.(motion);

        for (const document of motionDocuments) {
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
        }
      },
    });

    return {
      meetings,
      documents,
      motions,
      issues,
      stats: currentStats(),
    };
  }

  /** Import moties/amendementen from the site's registries.
   *
   * Failures here are reported but never fail the run: meetings and documents
   * are the primary product, and several sitenames have no usable registry at
   * all. */
  private async extractMotions(
    source: IbabsSourceDefinition,
    dateFrom: string,
    dateTo: string,
    context: {
      meetingIndex: MeetingIndex;
      meetingTypes: Map<string, string>;
      concurrency: number;
      registerIssue: (issue: ExtractionIssue) => Promise<void>;
      onMotion: (motion: MotionEntity, documents: DocumentEntity[]) => Promise<void>;
    },
  ): Promise<void> {
    const limit = Number(Deno.env.get("WOOZI_IBABS_MOTION_LIMIT") ?? `${DEFAULT_MOTION_LIMIT}`);
    if (limit <= 0) {
      return;
    }

    let lists: IbabsList[];
    try {
      lists = await this.client.getLists(source);
    } catch (error) {
      await context.registerIssue({
        severity: "warning",
        step: "list_motions",
        entity_id: source.key,
        message: `iBabs GetLists failed for ${source.ibabsSitename}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    const targets = lists.filter((list) => MOTION_LIST_PATTERN.test(list.ListName));
    if (targets.length === 0) {
      return;
    }

    const pending: Array<{ list: IbabsList; entry: IbabsListEntryBase }> = [];
    let skippedForLimit = 0;

    for (const list of targets) {
      let entries: IbabsListEntryBase[];
      try {
        entries = await this.client.listListEntries(source, list.ListId, dateFrom);
      } catch (error) {
        await context.registerIssue({
          severity: "warning",
          step: "list_motions",
          entity_id: source.key,
          message: `iBabs list "${list.ListName}" failed for ${source.ibabsSitename}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }

      for (const entry of entries) {
        if (!isEntryInWindow(entry.MutationDate, dateFrom, dateTo)) {
          continue;
        }
        if (pending.length >= limit) {
          skippedForLimit += 1;
          continue;
        }
        pending.push({ list, entry });
      }
    }

    if (skippedForLimit > 0) {
      await context.registerIssue({
        severity: "warning",
        step: "list_motions",
        entity_id: source.key,
        message:
          `iBabs ${source.ibabsSitename}: ${skippedForLimit} list entries skipped, over the ` +
          `${limit}-entry per-run cap (WOOZI_IBABS_MOTION_LIMIT). Narrow the date range to import them.`,
      });
    }

    // A motion mutated inside the run window often belongs to a much older
    // meeting — a status update on a 2024 motie is a routine edit. Those
    // meetings aren't in the index, so fetch the referenced day on demand;
    // without this the link lands only when the motion happens to have been
    // decided in the same window it was last edited in, and a re-import would
    // replace a linked motion with an unlinked one.
    const dateLoads = new Map<string, Promise<void>>();
    const ensureMeetingsForDate = (date: string): Promise<void> => {
      const existing = dateLoads.get(date);
      if (existing) {
        return existing;
      }
      const load = (async () => {
        if (context.meetingIndex.hasDate(date)) {
          return;
        }
        try {
          const dayMeetings = await this.client.listMeetingsByDateRange(source, date, date);
          for (const rawMeeting of dayMeetings) {
            try {
              context.meetingIndex.add(
                normalizeIbabsMeeting(source, rawMeeting, context.meetingTypes),
              );
            } catch {
              // Meetings without a date can't be indexed; they also can't be
              // the target of a dated back-reference.
            }
          }
        } catch (error) {
          await context.registerIssue({
            severity: "warning",
            step: "list_motions",
            entity_id: source.key,
            message: `iBabs meetings for ${date} (motion link) failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      })();
      dateLoads.set(date, load);
      return load;
    };

    await mapLimit(pending, context.concurrency, async ({ list, entry }) => {
      try {
        const detail = await this.client.getListEntry(source, list.ListId, entry.EntryId);
        // Empty for the ~half of sources without the digital voting module.
        const votes = await this.client.getListEntryVotes(source, entry.EntryId);

        const reference = parseAgendaPointReference(detail.Values["Agendapunt"]);
        if (reference) {
          await ensureMeetingsForDate(reference.meetingDate);
        }

        const motion = normalizeIbabsMotion(
          source,
          list,
          entry,
          detail,
          votes,
          context.meetingIndex,
        );
        await context.onMotion(motion, normalizeIbabsMotionDocuments(source, motion, detail));
      } catch (error) {
        await context.registerIssue({
          severity: "warning",
          step: "list_motions",
          entity_id: entry.EntryId,
          message: `iBabs list entry ${entry.EntryId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    });
  }

  async extractCommitEventsForDateRange(
    source: IbabsSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<EntityCommitEvent<WooziEntity>>> {
    const bundle = await this.extractForDateRange(source, dateFrom, dateTo);
    const entities = [...bundle.meetings, ...bundle.documents, ...(bundle.motions ?? [])];
    return await Promise.all(entities.map((entity) => buildEntityCommitEvent(entity)));
  }
}

export const __test__ = {
  splitDateRange,
  listMeetingsAdaptive,
  isSoapTimeout,
  isEntryInWindow,
  MOTION_LIST_PATTERN,
};
