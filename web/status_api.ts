import type {
  SourceStatus,
  SourceStatusState,
  StatusResponse,
  Supplier,
  SupplierStatus,
  SupplierStatusState,
} from "../src/types.ts";
import {
  getIngestStatus,
  type SourceRunStatus,
  type SupplierRunWindow,
} from "../src/ops/store.ts";
import { listCatalogSources, SUPPLIER_LABELS } from "../src/sources/index.ts";
import { getSourceIndexActivity, type SourceIndexActivity } from "./search_api.ts";

/** How long a source may go without a successful import before it stops
 * counting as current.
 *
 * Every implemented source is scheduled nightly, so 36 hours is one missed
 * night plus room for a long run -- the same window the production monitor
 * uses to decide a supplier has gone quiet. Individual failures inside it are
 * not interesting: the scheduler re-imports seven days either side, so a
 * source that misses one night is picked up by the next. */
const DEFAULT_WINDOW_HOURS = 36;

/** Below this many attempts a supplier's success rate says nothing -- a
 * supplier with two sources fails "100% of runs" the moment one of them has a
 * bad night. */
const MIN_MEANINGFUL_RUNS = 5;

const CACHE_TTL_MS = 10 * 60 * 1000;

/** Errors are published, so they get the treatment anything published gets.
 *
 * Query strings are dropped whole: Parlaeus carries its session id as `rid` in
 * the query (src/parlaeus/client.ts), and an error that quotes the failing URL
 * would put it in a public response. The path and host stay, because "which
 * host refused us" is the useful half. */
export function sanitizeErrorMessage(message: string): string | undefined {
  const stripped = message
    .replaceAll(/(https?:\/\/[^\s"'<>]*?)\?[^\s"'<>]*/g, "$1?…")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!stripped) return undefined;
  return stripped.length > 300 ? `${stripped.slice(0, 299)}…` : stripped;
}

function isFresh(timestamp: string | undefined, now: number, windowHours: number): boolean {
  if (!timestamp) return false;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && now - value <= windowHours * 3_600_000;
}

/** See SourceStatusState: `failing` is reserved for the case that does not fix
 * itself, so a source with a recent success is `ok` even if last night failed. */
function sourceState(
  implemented: boolean,
  run: SourceRunStatus | undefined,
  now: number,
  windowHours: number,
): SourceStatusState {
  if (!implemented) return "not_implemented";
  if (!run?.lastRunAt) return "never_imported";
  if (isFresh(run.lastSuccessAt, now, windowHours)) return "ok";
  if (run.lastRunStatus === "failed") return "failing";
  return "stale";
}

function supplierState(
  window: SupplierRunWindow | undefined,
  sourceCount: number,
): SupplierStatusState {
  if (sourceCount === 0) return "idle";
  if (!window || window.runCount === 0) return "idle";
  if (window.runCount >= MIN_MEANINGFUL_RUNS && window.succeededCount === 0) return "down";
  if (window.failedCount > window.succeededCount) return "degraded";
  return "ok";
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const value of values) {
    if (!value) continue;
    if (!best || value > best) best = value;
  }
  return best;
}

export function buildStatusResponse(options: {
  runStatus: { sources: SourceRunStatus[]; supplierWindows: SupplierRunWindow[] };
  indexActivity: Map<string, SourceIndexActivity> | null;
  now: number;
  windowHours: number;
}): StatusResponse {
  const { runStatus, indexActivity, now, windowHours } = options;
  const runBySource = new Map(runStatus.sources.map((row) => [row.sourceKey, row]));
  const windowBySupplier = new Map(runStatus.supplierWindows.map((row) => [row.supplier, row]));

  const sources: SourceStatus[] = listCatalogSources()
    .map((source) => {
      const run = runBySource.get(source.key);
      const activity = indexActivity?.get(source.key);
      const state = sourceState(source.implemented, run, now, windowHours);
      const lastErrorMessage =
        run?.lastRunStatus === "failed" && run.lastErrorMessage
          ? sanitizeErrorMessage(run.lastErrorMessage)
          : undefined;

      return {
        sourceKey: source.key,
        sourceRef: source.sourceRef,
        label: source.label ?? source.key.replaceAll("_", " "),
        supplier: source.supplier,
        organizationType: source.organizationType,
        cbsId: source.cbsId,
        state,
        lastSuccessAt: run?.lastSuccessAt,
        lastRunAt: run?.lastRunAt,
        lastRunStatus: run?.lastRunStatus,
        lastErrorMessage,
        latestContentDate: activity?.latestContentDate,
        lastIndexedAt: activity?.lastIndexedAt,
      } satisfies SourceStatus;
    })
    .sort((left, right) => left.label.localeCompare(right.label, "nl"));

  const suppliers: SupplierStatus[] = [...new Set(sources.map((source) => source.supplier))]
    .sort((left, right) => left.localeCompare(right, "nl"))
    .map((supplier) => {
      const own = sources.filter(
        (source) => source.supplier === supplier && source.state !== "not_implemented",
      );
      const window = windowBySupplier.get(supplier);
      const state = supplierState(window, own.length);

      return {
        supplier: supplier as Supplier,
        label: SUPPLIER_LABELS[supplier as Supplier] ?? supplier,
        state,
        sourceCount: own.length,
        okSourceCount: own.filter((source) => source.state === "ok").length,
        runCount: window?.runCount ?? 0,
        succeededCount: window?.succeededCount ?? 0,
        failedCount: window?.failedCount ?? 0,
        // Across every source of the supplier, not only the window: for a
        // supplier that is down this is how long it has been down, which is
        // the number nobody had in front of them for the ten days of #205.
        lastSuccessAt: latestTimestamp(own.map((source) => source.lastSuccessAt)),
        lastErrorMessage:
          state === "ok" || !window?.lastErrorMessage
            ? undefined
            : sanitizeErrorMessage(window.lastErrorMessage),
      } satisfies SupplierStatus;
    });

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours,
    indexActivityAvailable: indexActivity !== null,
    suppliers,
    sources,
  };
}

let cached: { value: StatusResponse; expiresAt: number } | null = null;
let inFlight: Promise<StatusResponse> | null = null;

async function computeStatus(windowHours: number): Promise<StatusResponse> {
  const runStatus = await getIngestStatus(windowHours);

  // Deliberately not Promise.all with the run query: the search index is the
  // optional half. A status endpoint that goes down when a dependency does is
  // reporting on the wrong thing.
  let indexActivity: Map<string, SourceIndexActivity> | null = null;
  try {
    indexActivity = await getSourceIndexActivity();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[status] index activity unavailable, reporting imports only: ${message}`);
  }

  return buildStatusResponse({
    runStatus,
    indexActivity,
    now: Date.now(),
    windowHours,
  });
}

export async function getStatus(windowHours = DEFAULT_WINDOW_HOURS): Promise<StatusResponse> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = computeStatus(windowHours)
    .then((value) => {
      cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    })
    .catch((error: unknown) => {
      // Serving a known-stale answer beats serving none: the callers of this
      // endpoint are watching for trouble, and that is exactly when the ops
      // database is most likely to be busy.
      if (cached) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[status] refresh failed, serving previous value: ${message}`);
        return cached.value;
      }
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export const __test__ = { buildStatusResponse, sanitizeErrorMessage, DEFAULT_WINDOW_HOURS };
