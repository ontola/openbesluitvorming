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
 */

import type { SourceProbe } from "../documents/source_presence.ts";
import type { ExportChangeRecord, MeetingEntity } from "../types.ts";

const DEFAULT_MAX_REMOVALS_PER_RUN = 25;

/** Entity kinds whose records list documents. */
const REFERENCING_PREFIXES = ["meeting:", "motion:"];

export interface SourceRemovalLog {
  getEntityRecord(sourceKey: string, entityId: string): ExportChangeRecord | null;
  findReferencedEntityIds(sourceKey: string, entityIds: string[], prefixes: string[]): Set<string>;
}

export interface SourceRemovalPlan {
  /** Document entity ids to retract. Empty when the cap was exceeded. */
  remove: Array<{ entityId: string; meetingId: string }>;
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

function attachmentIds(payload: unknown): string[] {
  const attachment = (payload as { attachment?: unknown } | undefined)?.attachment;
  return Array.isArray(attachment)
    ? attachment.filter((id): id is string => typeof id === "string")
    : [];
}

export class SourceRemovalTracker {
  private readonly candidates = new Map<string, string>();
  private readonly emitted = new Set<string>();
  private readonly skippedMeetings: string[] = [];
  private controlEntityId: string | undefined;

  constructor(
    private readonly sourceKey: string,
    private readonly log: SourceRemovalLog,
  ) {}

  /** Call before the meeting's new version is committed to the log. */
  observeMeeting(meeting: MeetingEntity): void {
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

  plan(maxPerRun: number): SourceRemovalPlan {
    const pending = [...this.candidates.keys()].filter((entityId) => {
      if (this.emitted.has(entityId)) {
        return false;
      }
      const current = this.log.getEntityRecord(this.sourceKey, entityId);
      return current?.op === "upsert";
    });
    const referenced =
      pending.length > 0
        ? this.log.findReferencedEntityIds(this.sourceKey, pending, REFERENCING_PREFIXES)
        : new Set<string>();
    const remove = pending
      .filter((entityId) => !referenced.has(entityId))
      .map((entityId) => ({ entityId, meetingId: this.candidates.get(entityId)! }));

    if (remove.length > maxPerRun) {
      return {
        remove: [],
        capExceeded: { candidates: remove.length, max: maxPerRun },
        skippedMeetings: this.skippedMeetings,
      };
    }
    return { remove, controlEntityId: this.controlEntityId, skippedMeetings: this.skippedMeetings };
  }
}

export interface ConfirmedRemovals {
  /** Confirmed gone, each with the supplier's answer as evidence. */
  remove: Array<{ entityId: string; meetingId: string; probe: SourceProbe }>;
  /** Candidates the supplier still serves, or could not say about. Without a
   * probe when the control document stopped the run before asking. */
  kept: Array<{ entityId: string; meetingId: string; probe?: SourceProbe }>;
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
