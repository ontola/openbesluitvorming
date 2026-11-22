import {
  type CachedStorage,
  materializeDocument,
  materializeInlineText,
} from "../documents/process.ts";
import { canonicalDocumentId, canonicalMeetingId } from "../ids.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import type {
  CommitteeEntity,
  DocumentEntity,
  ExtractedEntity,
  ExtractionBundle,
  ExtractionIssue,
  ExtractionRetraction,
  IngestExecutionMode,
  MeetingEntity,
  OdsSourceDefinition,
} from "../types.ts";
import { mapLimit } from "../util/map_limit.ts";
import { OdsFeedClient, type OdsInformatieobject } from "./feed.ts";
import { type MirrorStorage, OdsMirror, type Removal } from "./mirror.ts";
import {
  amsterdamDay,
  isPublicHttpsUrl,
  normalizeOdsMeeting,
  odsDocumentProblems,
  odsNativeId,
  vergaderingStart,
} from "./normalize.ts";

const DEFAULT_DOCUMENT_CONCURRENCY = 3;
const MAX_REDIRECTS = 3;

/** Downloads a document from the feed, refusing every hop that is not a
 * public https address: the URL came from someone else's feed, and a redirect
 * could otherwise point the worker at something inside our own network. */
export async function downloadFeedDocument(
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

/** Reads an ODS event polling feed into our mirror (src/ods/mirror.ts), then
 * turns the mirror into entities, like the extractors of the other suppliers
 * do with their APIs.
 *
 * A run emits the meetings in its window, and also every meeting the feed
 * changed since the last run, whatever its date: the feed says what changed,
 * so there is no need to wait for the nightly window to come by. The
 * documents go through the same materialization as everywhere else, so
 * caching, text extraction, BSN detection and the blocklist apply. Deletes
 * and redacts come back as `retractions` for the import to carry out. */
export class OdsExtractor {
  constructor(
    private readonly storageProvider: () => Promise<
      (MirrorStorage & CachedStorage) | undefined
    > = () => ObjectStorageClient.fromEnvironment(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async extractForDateRange(
    source: OdsSourceDefinition,
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
        'Execution mode "media_only" is Notubiz-only for now: ODS feeds carry no recordings yet.',
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
        message: "No object storage: the ODS feed mirror cannot be read",
      });
      return bundle();
    }

    const mirror = new OdsMirror(storage, source.key);
    // A rederive replays what we hold; only a full import reads the feed.
    if ((options.executionMode ?? "full") === "full") {
      try {
        await mirror.sync(new OdsFeedClient(source.feedUrl, source.organisatiecode, this.fetcher));
      } catch (error) {
        // What we hold is still good: import that, and the next run goes on
        // from the saved cursor.
        await registerIssue({
          severity: "warning",
          step: "list_events",
          message: `ODS feed could not be read (${source.feedUrl}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    const state = await mirror.state();
    const pending = new Set(state.pendingMeetings ?? []);
    const index = await mirror.index();
    const emitted: string[] = [];
    const seenCommittees = new Set<string>();
    const pendingDocuments = new Map<string, DocumentEntity>();

    for (const vergadering of index.vergaderingen.values()) {
      const start = vergaderingStart(vergadering);
      const day = start ? amsterdamDay(start) : undefined;
      const inWindow = day !== undefined && day >= dateFrom && day <= dateTo;
      if (!inWindow && !pending.has(vergadering.bronidentificatie)) continue;
      try {
        const {
          meeting,
          documents: docs,
          committee,
        } = await normalizeOdsMeeting(source, vergadering, index);
        if (committee && !seenCommittees.has(committee.id)) {
          seenCommittees.add(committee.id);
          if (retainEntities) committees.push(committee);
          await options.onEntity?.(committee);
        }
        meetingCount += 1;
        if (retainEntities) meetings.push(meeting);
        await options.onProgress?.(currentStats());
        await options.onEntity?.(meeting);
        emitted.push(vergadering.bronidentificatie);
        for (const doc of docs) {
          const problems = odsDocumentProblems(doc.raw as OdsInformatieobject);
          if (problems.length > 0) {
            await registerIssue({
              severity: "warning",
              step: "download_document",
              entity_id: doc.id,
              message: problems.join("; "),
            });
            continue;
          }
          pendingDocuments.set(doc.id, doc);
        }
      } catch (error) {
        await registerIssue({
          severity: "error",
          step: "get_meeting",
          entity_id: vergadering.bronidentificatie,
          message: error instanceof Error ? error.message : "Vergadering could not be read",
        });
      }
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
              download: (doc) => downloadFeedDocument(doc.original_url!, this.fetcher),
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

    // Only the meetings this run emitted come off the pending list; the
    // rest (a vergadering without a date, an error) stays for the next run.
    await mirror.acknowledgeImported(emitted.filter((bron) => pending.has(bron)));

    const removals = await mirror.pendingRemovals();
    const result = bundle();
    if (removals.length > 0) {
      result.retractions = await this.retractionsFor(source, mirror, removals);
    }
    return result;
  }

  private async retractionsFor(
    source: OdsSourceDefinition,
    mirror: OdsMirror,
    removals: Removal[],
  ): Promise<NonNullable<ExtractionBundle["retractions"]>> {
    const entries: ExtractionRetraction[] = [];
    const byEntity = new Map<string, Removal>();
    for (const removal of removals) {
      const reason = removal.op === "redact" ? "takedown" : "removed_at_source";
      const native = await odsNativeId(removal.bronidentificatie);
      if (removal.resourceType === "Agendapunt") {
        // Not an entity of its own: its meeting is imported again without it.
        await mirror.markRetracted(removal);
        continue;
      }
      const meeting = removal.meetings[0];
      const entry: ExtractionRetraction =
        removal.resourceType === "Vergadering"
          ? { entityId: canonicalMeetingId(source, native), entityType: "Meeting", reason }
          : {
              entityId: canonicalDocumentId(source, native),
              entityType: "Document",
              reason,
              ...(meeting
                ? { meetingId: canonicalMeetingId(source, await odsNativeId(meeting)) }
                : {}),
            };
      entries.push(entry);
      byEntity.set(entry.entityId, removal);
    }
    return {
      entries,
      done: async (entityIds) => {
        for (const id of entityIds) {
          const removal = byEntity.get(id);
          if (removal) await mirror.markRetracted(removal);
        }
      },
    };
  }
}
