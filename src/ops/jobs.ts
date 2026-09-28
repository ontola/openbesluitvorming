/**
 * The fixed set of mutating actions behind `/api/ops/*`.
 *
 * The web container only validates a request and queues it as an `ops_job`
 * row; a worker (src/worker.ts) claims the row and calls `executeOpsJob`.
 * Validation lives here so both sides run the same checks: the web side to
 * answer 400 immediately, the worker side because a row is not trusted just
 * for being in the table.
 *
 * Every action is a dry run unless the request carries `apply: true` and a
 * `confirm` equal to the source key it acts on (or `"all"` for a re-enqueue
 * across every source). A takedown is confirmed with the document's entity id,
 * or with `"<n> documents"` when it names several.
 */

import { startIngest } from "../ingest.ts";
import { getProjectableSource, getSource } from "../sources/index.ts";
import { findActiveRun, type OpsJobRecord } from "./store.ts";
import { purgeSource } from "./purge_source.ts";
import { deleteDocuments, parseDocumentEntityId } from "./delete_document.ts";
import {
  DEFAULT_MIN_WINDOW_DAYS,
  DEFAULT_REENQUEUE_STATUSES,
  parseReenqueueStatuses,
  reenqueueFailedWindows,
  type ReenqueueStatus,
} from "./reenqueue_failed_windows.ts";

export const OPS_ACTIONS = [
  "rerun_source",
  "reenqueue_failed_windows",
  "purge_source",
  "delete_document",
] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

export function isOpsAction(value: string): value is OpsAction {
  return (OPS_ACTIONS as readonly string[]).includes(value);
}

/** The `confirm` value that unlocks a re-enqueue without a source filter. */
export const CONFIRM_ALL_SOURCES = "all";

export interface RerunSourceParams {
  source: string;
  mode: "full" | "reindex_only";
  dateFrom: string;
  dateTo: string;
}

export interface ReenqueueParams {
  source: string | null;
  statuses: ReenqueueStatus[];
  minWindowDays: number;
  fromYear: string | null;
  toYear: string | null;
}

export interface PurgeSourceParams {
  source: string;
  quickwit: boolean;
  keepStorage: boolean;
}

export interface DeleteDocumentParams {
  entityIds: string[];
  reason: string;
}

/** Most documents one takedown job may name. A BSN finding set is usually a
 * handful; a larger batch is a sign something other than a takedown is going
 * on, and belongs on the host where someone watches it. */
export const MAX_DELETE_DOCUMENTS = 100;

export type OpsJobParams =
  | RerunSourceParams
  | ReenqueueParams
  | PurgeSourceParams
  | DeleteDocumentParams;

export class OpsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsValidationError";
  }
}

export interface ValidatedOpsRequest {
  action: OpsAction;
  params: OpsJobParams;
  apply: boolean;
  /** What `confirm` has to equal for `apply` to be accepted. */
  confirmTarget: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;
// Stored in the blocklist and shown in dry runs; kept to a short label.
const REASON = /^[a-z0-9_-]{1,40}$/;

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new OpsValidationError(`"${key}" must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined) {
    throw new OpsValidationError(`"${key}" is required.`);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new OpsValidationError(`"${key}" must be a boolean.`);
  }
  return value;
}

/** Resolve a source through the catalog so a typo is a 400, not a job that
 * quietly acts on nothing. Returns the canonical key. */
function resolveSourceKey(sourceKey: string, requireRunnable: boolean): string {
  if (sourceKey.startsWith("__supplier__:")) {
    throw new OpsValidationError("Supplier-wide selectors are not supported; name one source.");
  }
  try {
    return (requireRunnable ? getSource(sourceKey) : getProjectableSource(sourceKey)).key;
  } catch (error) {
    throw new OpsValidationError(error instanceof Error ? error.message : String(error));
  }
}

function validateRerunSource(body: Record<string, unknown>): RerunSourceParams {
  // Only sources that are actually imported: a rerun calls the supplier (or,
  // for a reindex, re-projects a source someone decided to keep serving).
  const source = resolveSourceKey(requiredString(body, "source"), true);
  const mode = optionalString(body, "mode") ?? "full";
  if (mode !== "full" && mode !== "reindex_only") {
    throw new OpsValidationError(`"mode" must be "full" or "reindex_only".`);
  }
  const dateFrom = optionalString(body, "dateFrom");
  const dateTo = optionalString(body, "dateTo");
  // Same rules as /api/admin/rerun: a reindex always covers the whole source,
  // so a date range would be accepted and silently ignored.
  if (mode === "reindex_only") {
    if (dateFrom || dateTo) {
      throw new OpsValidationError("A reindex always covers the whole source; omit the dates.");
    }
    return { source, mode, dateFrom: "", dateTo: "" };
  }
  if (!dateFrom || !dateTo) {
    throw new OpsValidationError(`A full rerun needs both "dateFrom" and "dateTo".`);
  }
  if (!DATE.test(dateFrom) || !DATE.test(dateTo)) {
    throw new OpsValidationError("Dates must be YYYY-MM-DD.");
  }
  if (dateFrom > dateTo) {
    throw new OpsValidationError(`"dateFrom" must be on or before "dateTo".`);
  }
  return { source, mode, dateFrom, dateTo };
}

function validateReenqueue(body: Record<string, unknown>): ReenqueueParams {
  const sourceInput = optionalString(body, "source");
  // Projectable, not runnable: the failed windows of a source that has since
  // been switched off are still worth listing in a dry run.
  const source = sourceInput ? resolveSourceKey(sourceInput, false) : null;

  let statuses = DEFAULT_REENQUEUE_STATUSES;
  const rawStatuses = body.statuses;
  if (rawStatuses !== undefined && rawStatuses !== null) {
    const joined = Array.isArray(rawStatuses)
      ? rawStatuses.map(String).join(",")
      : typeof rawStatuses === "string"
        ? rawStatuses
        : null;
    if (joined === null) {
      throw new OpsValidationError(`"statuses" must be a list of "failed" and/or "partial".`);
    }
    try {
      statuses = parseReenqueueStatuses(joined);
    } catch (error) {
      throw new OpsValidationError(error instanceof Error ? error.message : String(error));
    }
    if (statuses.length === 0) {
      throw new OpsValidationError(`"statuses" must not be empty.`);
    }
  }

  let minWindowDays = DEFAULT_MIN_WINDOW_DAYS;
  if (body.minWindowDays !== undefined && body.minWindowDays !== null) {
    if (typeof body.minWindowDays !== "number" || !Number.isFinite(body.minWindowDays)) {
      throw new OpsValidationError(`"minWindowDays" must be a number.`);
    }
    minWindowDays = body.minWindowDays;
  }

  const fromYear = optionalString(body, "fromYear") ?? null;
  const toYear = optionalString(body, "toYear") ?? null;
  for (const [key, value] of [
    ["fromYear", fromYear],
    ["toYear", toYear],
  ] as const) {
    if (value !== null && !YEAR.test(value)) {
      throw new OpsValidationError(`"${key}" must be a four-digit year.`);
    }
  }

  return { source, statuses, minWindowDays, fromYear, toYear };
}

function validatePurge(body: Record<string, unknown>): PurgeSourceParams {
  // Projectable, not runnable: a source is switched off in the catalog before
  // its data is removed (see purgeSource).
  const source = resolveSourceKey(requiredString(body, "source"), false);
  return {
    source,
    quickwit: optionalBoolean(body, "quickwit"),
    keepStorage: optionalBoolean(body, "keepStorage"),
  };
}

function validateDeleteDocument(body: Record<string, unknown>): DeleteDocumentParams {
  const raw = body.entityIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpsValidationError(`"entityIds" must be a non-empty list of document entity ids.`);
  }
  if (raw.length > MAX_DELETE_DOCUMENTS) {
    throw new OpsValidationError(
      `At most ${MAX_DELETE_DOCUMENTS} documents per job; use scripts/delete_document.ts for more.`,
    );
  }
  const entityIds = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      throw new OpsValidationError(`"entityIds" must contain strings.`);
    }
    const entityId = value.trim();
    let sourceKey: string;
    try {
      sourceKey = parseDocumentEntityId(entityId).sourceKey;
    } catch (error) {
      throw new OpsValidationError(error instanceof Error ? error.message : String(error));
    }
    // The id's source has to exist, so a mangled id is a 400 rather than a
    // job that inspects nothing.
    resolveSourceKey(sourceKey, false);
    entityIds.add(entityId);
  }
  const reason = optionalString(body, "reason") ?? "takedown";
  if (!REASON.test(reason)) {
    throw new OpsValidationError(`"reason" must be a short label such as "bsn" or "takedown".`);
  }
  return { entityIds: [...entityIds], reason };
}

function validateParams(action: OpsAction, body: Record<string, unknown>): OpsJobParams {
  switch (action) {
    case "rerun_source":
      return validateRerunSource(body);
    case "reenqueue_failed_windows":
      return validateReenqueue(body);
    case "purge_source":
      return validatePurge(body);
    case "delete_document":
      return validateDeleteDocument(body);
  }
}

function confirmTargetFor(params: OpsJobParams): string {
  if ("entityIds" in params) {
    return params.entityIds.length === 1
      ? params.entityIds[0]
      : `${params.entityIds.length} documents`;
  }
  return params.source ?? CONFIRM_ALL_SOURCES;
}

/** Validate an ops request body for `action`. Throws OpsValidationError. */
export function validateOpsRequest(action: OpsAction, body: unknown): ValidatedOpsRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OpsValidationError("Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const params = validateParams(action, record);
  const apply = optionalBoolean(record, "apply");
  const confirmTarget = confirmTargetFor(params);
  if (apply) {
    const confirm = optionalString(record, "confirm");
    if (confirm !== confirmTarget) {
      throw new OpsValidationError(
        `"apply": true needs "confirm": "${confirmTarget}" to guard against acting on the wrong target.`,
      );
    }
  }
  return { action, params, apply, confirmTarget };
}

/** Run a claimed job. Output goes through `log`, line by line; a thrown error
 * marks the job failed. */
export async function executeOpsJob(
  job: Pick<OpsJobRecord, "action" | "params" | "apply">,
  log: (line: string) => void,
): Promise<void> {
  if (!isOpsAction(job.action)) {
    throw new Error(`Unknown ops action "${job.action}".`);
  }
  const { action, params, apply } = validateOpsRequest(job.action, {
    ...job.params,
    apply: job.apply,
    // Confirmation was checked when the job was accepted.
    confirm: confirmTargetFor(job.params as unknown as OpsJobParams),
  });

  switch (action) {
    case "rerun_source":
      return await runRerunSource(params as RerunSourceParams, apply, log);
    case "reenqueue_failed_windows": {
      const p = params as ReenqueueParams;
      await reenqueueFailedWindows(
        {
          apply,
          source: p.source ?? undefined,
          statuses: p.statuses,
          minWindowDays: p.minWindowDays,
          fromYear: p.fromYear ?? undefined,
          toYear: p.toYear ?? undefined,
        },
        log,
      );
      return;
    }
    case "purge_source": {
      const p = params as PurgeSourceParams;
      const result = await purgeSource(
        p.source,
        { apply, quickwit: p.quickwit, keepStorage: p.keepStorage },
        log,
      );
      if (!result.storageComplete) {
        throw new Error("Object storage was not fully cleared; re-running is safe.");
      }
      return;
    }
    case "delete_document": {
      const p = params as DeleteDocumentParams;
      const result = await deleteDocuments(p.entityIds, { apply, reason: p.reason }, log);
      if (result.failures > 0) {
        throw new Error(
          `${result.failures} of ${result.inspected} document(s) failed; re-running is safe.`,
        );
      }
      return;
    }
  }
}

async function runRerunSource(
  params: RerunSourceParams,
  apply: boolean,
  log: (line: string) => void,
): Promise<void> {
  const range = params.mode === "full" ? ` ${params.dateFrom} to ${params.dateTo}` : "";
  const active = await findActiveRun({
    sourceKey: params.source,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    executionMode: params.mode,
  });
  if (active) {
    throw new Error(`Run ${active.id} for the same source and window is already ${active.status}.`);
  }
  if (!apply) {
    log(`[dry-run] Would enqueue a ${params.mode} run for ${params.source}${range}.`);
    return;
  }
  const run = await startIngest(params.source, params.dateFrom, params.dateTo, {
    ingestToQuickwit: true,
    trigger: "api",
    executionMode: params.mode,
  });
  log(`Enqueued ${params.mode} run ${run.id} for ${params.source}${range}.`);
}
