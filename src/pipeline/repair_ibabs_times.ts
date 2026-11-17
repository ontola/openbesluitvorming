import type { ExportChangeRecord } from "../types.ts";
import type { ExportChangesLog } from "../exports/log.ts";
import { reinterpretZuluAsWallClock } from "../util/local_time.ts";

/** When the iBabs normaliser stopped stamping its bare readings `Z` (#203).
 *
 * 3ed6e4b moved iBabs onto `supplierDateTimeToUtc`; it reached production
 * with the deploy of a8c3a49, which started at 2026-08-13T09:27:30Z. Every
 * iBabs record written before that carries a Dutch wall clock labelled UTC.
 * Records written after it are correct, so the cutoff errs early: a record
 * written in the minutes the deploy took stays as it is rather than risk
 * shifting a correct value a second time. */
export const IBABS_ZULU_STAMPING_ENDED_AT = "2026-08-13T09:27:00Z";

/** The fields the old normaliser wrote from `MeetingDate` / `EndTime`, and
 * the ones that copied them. Measured on gouda's export log (2026-11-05):
 * no other field of a pre-cutoff iBabs record holds a time of day. */
const REPAIRED_FIELDS = ["start_date", "end_date", "last_discussed_at"] as const;
const REPAIRED_TYPES = new Set(["Meeting", "Document", "Motion"]);

export interface IbabsTimeRepair {
  record: ExportChangeRecord;
  payload: Record<string, unknown>;
  changes: Array<{ field: string; from: string; to: string }>;
}

/** What a stored record should hold instead, or null when it needs nothing.
 *
 * Only iBabs upserts written before `before` qualify: the write time is the
 * one thing that tells an old wall clock apart from a correct instant. */
export function planIbabsTimeRepair(
  record: ExportChangeRecord,
  before: string = IBABS_ZULU_STAMPING_ENDED_AT,
): IbabsTimeRepair | null {
  if (
    record.op !== "upsert" ||
    record.supplier !== "ibabs" ||
    !REPAIRED_TYPES.has(record.entity_type) ||
    !(Date.parse(record.time) < Date.parse(before))
  ) {
    return null;
  }
  const original = record.payload as Record<string, unknown> | undefined;
  if (!original || typeof original !== "object") {
    return null;
  }

  const payload: Record<string, unknown> = { ...original };
  const changes: IbabsTimeRepair["changes"] = [];
  for (const field of REPAIRED_FIELDS) {
    const value = payload[field];
    if (typeof value !== "string") {
      continue;
    }
    const corrected = reinterpretZuluAsWallClock(value);
    if (corrected !== value) {
      payload[field] = corrected;
      changes.push({ field, from: value, to: corrected });
    }
  }
  return changes.length > 0 ? { record, payload, changes } : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The record to append for a planned repair.
 *
 * The hash is taken over the stored (compact) payload, not the full entity an
 * import hashes, so it will not match what the next import of the same entity
 * produces. That costs one extra upsert with identical dates when that import
 * comes, which is the honest outcome: the log cannot claim a hash for content
 * it does not hold. */
export async function buildRepairedRecord(
  repair: IbabsTimeRepair,
  time: string,
): Promise<Omit<ExportChangeRecord, "seq">> {
  const { seq: _seq, ...rest } = repair.record;
  const contentHash = `sha256:${await sha256Hex(stableStringify(repair.payload))}`;
  return {
    ...rest,
    time,
    content_hash: contentHash,
    commit_id: `commit:${repair.record.entity_id}:${contentHash.slice(7, 19)}`,
    payload: repair.payload,
  };
}

export interface IbabsTimeRepairStats {
  scanned: number;
  repaired: number;
  byType: Record<string, number>;
  samples: IbabsTimeRepair[];
}

/** Walk a source's live records and repair the ones the old normaliser wrote.
 *
 * Without `apply` nothing is written. With it, each corrected record is
 * appended to the export log, so the change feed carries the fix to every
 * consumer, and handed to `onRepaired` for projection. */
export async function repairIbabsTimes(
  sourceKey: string,
  context: {
    exportLog: ExportChangesLog;
    apply: boolean;
    before?: string;
    now?: () => string;
    sampleSize?: number;
    onRepaired?: (records: ExportChangeRecord[]) => Promise<void>;
  },
): Promise<IbabsTimeRepairStats> {
  const stats: IbabsTimeRepairStats = { scanned: 0, repaired: 0, byType: {}, samples: [] };
  const sampleSize = context.sampleSize ?? 3;
  const now = context.now ?? (() => new Date().toISOString());
  let cursor: string | null = null;

  while (true) {
    const page = context.exportLog.readSnapshot(sourceKey, { cursor, limit: 500 });
    const appended: ExportChangeRecord[] = [];
    for (const record of page.records) {
      stats.scanned += 1;
      const repair = planIbabsTimeRepair(record, context.before);
      if (!repair) {
        continue;
      }
      stats.repaired += 1;
      stats.byType[record.entity_type] = (stats.byType[record.entity_type] ?? 0) + 1;
      if (stats.samples.length < sampleSize) {
        stats.samples.push(repair);
      }
      if (context.apply) {
        const written = context.exportLog.recordRepair(await buildRepairedRecord(repair, now()));
        if (written) {
          appended.push(written);
        }
      }
    }
    if (appended.length > 0) {
      await context.onRepaired?.(appended);
    }
    if (!page.hasMore) {
      break;
    }
    cursor = page.nextCursor;
  }

  if (context.apply && stats.repaired > 0) {
    await context.exportLog.flush(sourceKey);
  }
  return stats;
}
