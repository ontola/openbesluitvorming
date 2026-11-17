/**
 * Notice documents that a source has taken off a meeting since we imported
 * them.
 *
 * An import only ever adds: a document the supplier stopped listing used to
 * stay in search until someone removed it by hand. Every run already fetches
 * each meeting in its window again, and the meeting lists its documents in
 * `attachment`, so comparing that list with the one we exported last time
 * tells us which documents were dropped. We only ever compare a meeting with
 * itself, never infer anything from a meeting that did not come back: a
 * supplier that is down or times out yields no meeting, so it can remove
 * nothing.
 *
 * Guards, in order:
 *   - A meeting whose new list shares no document with the old one is skipped.
 *     That is what an emptied agenda or a changed id scheme looks like, and
 *     neither is a source deleting documents one by one.
 *   - A document emitted anywhere in the same run is kept (it moved).
 *   - A document another live meeting or motion of the source still lists is
 *     kept (it was on two agendas and left one).
 *   - A run that would remove more than `maxPerRun` documents removes none
 *     and reports instead.
 *   - The supplier itself has to say the document is gone, with the same
 *     calibrated responses as the revalidation sweep. A document that was
 *     only unlinked from the agenda but still downloads stays. So that an
 *     outage or a block cannot pass for a removal, a document the meeting
 *     still lists is asked first and has to answer "live".
 *   - One sighting is not enough (#380). The first run that finds a document
 *     dropped and gone only records it as a suspect. A later run, at least
 *     `minSuspectAgeMs` after that, retracts it if the meeting still leaves
 *     it out and the supplier again says gone. iBabs rebuilds an agenda
 *     bundle during the day under the same id, and in the first two weeks a
 *     third of the bundles retracted after one night were back the next day.
 *     A suspect the meeting lists again, or that the supplier serves again,
 *     is forgotten.
 */

import type { SourceProbe } from "../documents/source_presence.ts";
import type { ExportChangeRecord, MeetingEntity } from "../types.ts";

const DEFAULT_MAX_REMOVALS_PER_RUN = 25;
const DEFAULT_MIN_SUSPECT_AGE_HOURS = 12;

/** Entity kinds whose records list documents. */
const REFERENCING_PREFIXES = ["meeting:", "motion:"];

export interface SourceRemovalLog {
  getEntityRecord(sourceKey: string, entityId: string): ExportChangeRecord | null;
  findReferencedEntityIds(sourceKey: string, entityIds: string[], prefixes: string[]): Set<string>;
}

/** A document an earlier run found dropped and gone once. */
export interface SourceRemovalSuspect {
  entityId: string;
  meetingId: string;
  firstSeenAt: string;
}

export interface SourceRemovalCandidate {
  entityId: string;
  meetingId: string;
  /** Set for a second sighting: when the first run saw it. Without it the
   * candidate is a first sighting and only becomes a suspect. */
  firstSeenAt?: string;
}

export interface SourceRemovalPlan {
  /** Documents to ask the supplier about. Empty when the cap was exceeded. */
  remove: SourceRemovalCandidate[];
  /** Suspects that are back on their meeting, emitted again or already
   * deleted: forget them. */
  clearSuspects?: string[];
  /** A document still listed by one of those meetings, to tell an outage
   * apart from a removal. */
  controlEntityId?: string;
  /** Set when the cap stopped the run from removing anything. */
  capExceeded?: { candidates: number; max: number };
  skippedMeetings: string[];
}

export function sourceRemovalsEnabled(): boolean {
  return Deno.env.get("WOOZI_SOURCE_REMOVALS") !== "0";
}

export function maxSourceRemovalsPerRun(): number {
  const value = Number(
    Deno.env.get("WOOZI_SOURCE_REMOVALS_MAX_PER_RUN") ?? DEFAULT_MAX_REMOVALS_PER_RUN,
  );
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_REMOVALS_PER_RUN;
}

/** How long a suspect waits before a run may retract it. Long enough that a
 * second run on the same night (a manual run, the weekly sweep) does not
 * count as a second sighting. */
export function minSourceRemovalSuspectAgeMs(): number {
  const value = Number(
    Deno.env.get("WOOZI_SOURCE_REMOVALS_MIN_HOURS") ?? DEFAULT_MIN_SUSPECT_AGE_HOURS,
  );
  const hours = Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_SUSPECT_AGE_HOURS;
  return hours * 3_600_000;
}

function attachmentIds(payload: unknown): string[] {
  const attachment = (payload as { attachment?: unknown } | undefined)?.attachment;
  return Array.isArray(attachment)
    ? attachment.filter((id): id is string => typeof id === "string")
    : [];
}

export class SourceRemovalTracker {
  private readonly candidates = new Map<string, string>();
  private readonly emitted = new Set<string>();
  /** Every meeting this run saw, with the documents it lists now. */
  private readonly observed = new Map<string, Set<string>>();
  private readonly skippedMeetings: string[] = [];
  private controlEntityId: string | undefined;

  constructor(
    private readonly sourceKey: string,
    private readonly log: SourceRemovalLog,
  ) {}

  /** Call before the meeting's new version is committed to the log. */
  observeMeeting(meeting: MeetingEntity): void {
    this.observed.set(meeting.id, new Set(meeting.attachment ?? []));
    const previous = this.log.getEntityRecord(this.sourceKey, meeting.id);
    if (!previous || previous.op !== "upsert") {
      return;
    }
    const before = attachmentIds(previous.payload);
    if (before.length === 0) {
      return;
    }
    const after = new Set(meeting.attachment ?? []);
    const dropped = before.filter((id) => !after.has(id));
    if (dropped.length === 0) {
      return;
    }
    if (dropped.length === before.length) {
      this.skippedMeetings.push(meeting.id);
      return;
    }
    this.controlEntityId ??= before.find((id) => after.has(id));
    for (const entityId of dropped) {
      if (entityId.startsWith("document:")) {
        this.candidates.set(entityId, meeting.id);
      }
    }
  }

  /** Every entity the run produced, including blocklisted ones it skipped. */
  observeEmitted(entityId: string): void {
    this.emitted.add(entityId);
  }

  plan(
    maxPerRun: number,
    options: { suspects?: SourceRemovalSuspect[]; now?: Date; minSuspectAgeMs?: number } = {},
  ): SourceRemovalPlan {
    const isLive = (entityId: string) =>
      !this.emitted.has(entityId) &&
      this.log.getEntityRecord(this.sourceKey, entityId)?.op === "upsert";

    const firstSeen = new Map<string, string>();
    const meetingOf = new Map(this.candidates);
    const clearSuspects: string[] = [];
    let control = this.controlEntityId;
    const now = (options.now ?? new Date()).getTime();
    const minAge = options.minSuspectAgeMs ?? minSourceRemovalSuspectAgeMs();
    for (const suspect of options.suspects ?? []) {
      const listed = this.observed.get(suspect.meetingId);
      if (!listed) {
        // The meeting did not come back this run: no new sighting either way.
        continue;
      }
      if (listed.has(suspect.entityId) || !isLive(suspect.entityId)) {
        clearSuspects.push(suspect.entityId);
        continue;
      }
      if (now - Date.parse(suspect.firstSeenAt) < minAge) {
        continue;
      }
      firstSeen.set(suspect.entityId, suspect.firstSeenAt);
      meetingOf.set(suspect.entityId, suspect.meetingId);
      // A meeting unchanged since the first sighting dropped nothing new, so
      // no control document was picked yet: take one it still lists.
      control ??= [...listed].find((id) => id.startsWith("document:"));
    }

    const pending = [...meetingOf.keys()].filter(isLive);
    const referenced =
      pending.length > 0
        ? this.log.findReferencedEntityIds(this.sourceKey, pending, REFERENCING_PREFIXES)
        : new Set<string>();
    for (const entityId of pending) {
      if (referenced.has(entityId) && firstSeen.has(entityId)) {
        clearSuspects.push(entityId);
      }
    }
    const remove = pending
      .filter((entityId) => !referenced.has(entityId))
      .map((entityId): SourceRemovalCandidate => {
        const seen = firstSeen.get(entityId);
        return {
          entityId,
          meetingId: meetingOf.get(entityId)!,
          ...(seen ? { firstSeenAt: seen } : {}),
        };
      });
    const cleared = clearSuspects.length > 0 ? { clearSuspects } : {};

    if (remove.length > maxPerRun) {
      return {
        remove: [],
        ...cleared,
        capExceeded: { candidates: remove.length, max: maxPerRun },
        skippedMeetings: this.skippedMeetings,
      };
    }
    return {
      remove,
      ...cleared,
      controlEntityId: control,
      skippedMeetings: this.skippedMeetings,
    };
  }
}

export interface ConfirmedRemovals {
  /** Confirmed gone, each with the supplier's answer as evidence. */
  remove: Array<SourceRemovalCandidate & { probe: SourceProbe }>;
  /** Candidates the supplier still serves, or could not say about. Without a
   * probe when the control document stopped the run before asking. */
  kept: Array<SourceRemovalCandidate & { probe?: SourceProbe }>;
  /** The still-listed document asked first, and its answer. */
  control?: { entityId: string; probe: SourceProbe };
  /** True when the control document did not answer "live". */
  controlFailed?: boolean;
}

function originalUrl(record: ExportChangeRecord | null): string | undefined {
  const url = (record?.payload as { original_url?: unknown } | undefined)?.original_url;
  return typeof url === "string" ? url : undefined;
}

/** Keep only the candidates the supplier confirms are gone. */
export async function confirmRemovalsAtSource(
  plan: SourceRemovalPlan,
  options: {
    sourceKey: string;
    supplier: string;
    log: SourceRemovalLog;
    probe: (supplier: string, url: string | undefined) => Promise<SourceProbe>;
  },
): Promise<ConfirmedRemovals> {
  const urlOf = (entityId: string) =>
    originalUrl(options.log.getEntityRecord(options.sourceKey, entityId));
  if (plan.remove.length === 0) {
    return { remove: [], kept: [] };
  }
  const control = plan.controlEntityId
    ? {
        entityId: plan.controlEntityId,
        probe: await options.probe(options.supplier, urlOf(plan.controlEntityId)),
      }
    : undefined;
  if (control?.probe.presence !== "live") {
    return { remove: [], kept: plan.remove, control, controlFailed: true };
  }
  const remove: ConfirmedRemovals["remove"] = [];
  const kept: ConfirmedRemovals["kept"] = [];
  for (const entry of plan.remove) {
    const probe = await options.probe(options.supplier, urlOf(entry.entityId));
    if (probe.presence === "gone") {
      remove.push({ ...entry, probe });
    } else {
      kept.push({ ...entry, probe });
    }
  }
  return { remove, kept, control };
}
