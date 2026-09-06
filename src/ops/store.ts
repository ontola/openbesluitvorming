import { DatabaseSync } from "node:sqlite";
import { getConfigValue } from "../config.ts";
import type {
  AdminCoverageCell,
  AdminCoverageResponse,
  AdminCoverageRow,
  AdminRunSummary,
  ExtractionIssue,
  IngestExecutionMode,
  IngestRunRecord,
  IngestRunTrigger,
} from "../types.ts";

let databasePromise: Promise<DatabaseSync> | null = null;

async function getDatabase(): Promise<DatabaseSync> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const path = await getConfigValue("WOOZI_KV_PATH", "./woozi-ops.sqlite3");
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (directory) {
        await Deno.mkdir(directory, { recursive: true }).catch(() => undefined);
      }

      const db = new DatabaseSync(path);
      // Four worker containers (each with INGEST_CONCURRENCY tasks) plus the
      // web container all write to this single file on a shared Docker
      // volume. Enqueuing the full-history backfill on 2026-07-12 produced
      // 679 "database is locked" errors and killed ~700 windows outright --
      // 2013 lost 316 of 330 sources -- because 5s was not long enough to
      // outlast the write lock under that fan-in. Waiting is always better
      // than failing here: the caller's alternative is losing the run.
      db.exec("PRAGMA busy_timeout=30000");
      db.exec("PRAGMA journal_mode=WAL");
      // WAL already survives process death (container restart, OOM kill);
      // FULL additionally fsyncs on every commit, which is what makes each
      // writer hold the lock long enough for others to time out. NORMAL only
      // risks the most recent commits on *host* power loss, and this database
      // is reconstructible from the sources and backed up daily.
      db.exec("PRAGMA synchronous=NORMAL");
      // Default autocheckpoint (1000 pages) was not keeping up: both WAL
      // files had grown past 330MB, which slows every read and wastes disk on
      // a host that already trips its 80% alert. Checkpoint less often but in
      // bigger batches, so writers spend less total time blocked.
      db.exec("PRAGMA wal_autocheckpoint=4000");
      db.exec(`
        CREATE TABLE IF NOT EXISTS ingest_run (
          id TEXT PRIMARY KEY,
          source_key TEXT NOT NULL,
          supplier TEXT NOT NULL,
          date_from TEXT NOT NULL,
          date_to TEXT NOT NULL,
          trigger_mode TEXT NOT NULL,
          execution_mode TEXT NOT NULL DEFAULT 'full',
          parent_run_id TEXT,
          projection_version TEXT,
          derivation_version TEXT,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          meeting_count INTEGER NOT NULL DEFAULT 0,
          document_count INTEGER NOT NULL DEFAULT 0,
          cache_hits INTEGER NOT NULL DEFAULT 0,
          downloaded_count INTEGER NOT NULL DEFAULT 0,
          issue_count INTEGER NOT NULL DEFAULT 0,
          motion_count INTEGER NOT NULL DEFAULT 0,
          recording_count INTEGER NOT NULL DEFAULT 0,
          quickwit_index_id TEXT,
          error_message TEXT
        );
        CREATE TABLE IF NOT EXISTS ingest_run_issue (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          step TEXT NOT NULL,
          entity_id TEXT,
          message TEXT NOT NULL,
          details TEXT,
          FOREIGN KEY(run_id) REFERENCES ingest_run(id)
        );
        CREATE TABLE IF NOT EXISTS document_blocklist (
          entity_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS document_revalidation (
          entity_id TEXT PRIMARY KEY,
          supplier TEXT NOT NULL,
          source_key TEXT NOT NULL,
          url TEXT,
          streak INTEGER NOT NULL DEFAULT 0,
          last_checked_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS coverage_check (
        source_key TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        window_from TEXT NOT NULL,
        window_to TEXT NOT NULL,
        supplier_documents INTEGER NOT NULL,
        held_documents INTEGER NOT NULL,
        missing_documents INTEGER NOT NULL,
        missing_sample TEXT NOT NULL,
        supplier_meetings INTEGER NOT NULL,
        register_entries INTEGER NOT NULL,
        warnings INTEGER NOT NULL,
        error TEXT,
        PRIMARY KEY (source_key, checked_at)
      );
      CREATE TABLE IF NOT EXISTS revalidation_cursor (
          supplier TEXT PRIMARY KEY,
          start_offset INTEGER NOT NULL DEFAULT 0
        );
      `);
      try {
        db.exec("ALTER TABLE ingest_run_issue ADD COLUMN details TEXT");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'full'");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN parent_run_id TEXT");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN projection_version TEXT");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN derivation_version TEXT");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN interrupted_count INTEGER NOT NULL DEFAULT 0");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN claimed_at TEXT");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN motion_count INTEGER NOT NULL DEFAULT 0");
      } catch {
        // Column already exists on initialized databases.
      }
      try {
        db.exec("ALTER TABLE ingest_run ADD COLUMN recording_count INTEGER NOT NULL DEFAULT 0");
      } catch {
        // Column already exists on initialized databases.
      }
      // getIngestStatus() asks for the newest full import per source. Without
      // this the question is a scan of every run ever recorded (48k rows and
      // one more per source per night), on the same single-threaded process
      // that answers searches.
      db.exec(
        `CREATE INDEX IF NOT EXISTS ingest_run_mode_source_started
         ON ingest_run(execution_mode, source_key, started_at DESC)`,
      );
      return db;
    })();
  }

  return await databasePromise;
}

export interface RunDetails {
  run: IngestRunRecord;
  issues: ExtractionIssue[];
}

export interface DocumentBlocklistEntry {
  entity_id: string;
  reason: string;
  details?: string;
  created_at: string;
}

/** Blocks a document from (re-)ingestion. Checked in materializeDocument
 * (before the S3 cache short-circuit) and in the ingest onEntity handler
 * (before Quickwit projection and the export log). */
export async function addDocumentToBlocklist(
  entityId: string,
  reason: string,
  details?: string,
): Promise<void> {
  const db = await getDatabase();
  db.prepare(
    `INSERT INTO document_blocklist (entity_id, reason, details, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET reason = excluded.reason, details = excluded.details`,
  ).run(entityId, reason, details ?? null, new Date().toISOString());
}

export async function isDocumentBlocklisted(entityId: string): Promise<boolean> {
  const db = await getDatabase();
  const row = db
    .prepare("SELECT 1 as present FROM document_blocklist WHERE entity_id = ?")
    .get(entityId);
  return Boolean(row);
}

export async function removeDocumentFromBlocklist(entityId: string): Promise<void> {
  const db = await getDatabase();
  db.prepare("DELETE FROM document_blocklist WHERE entity_id = ?").run(entityId);
}

export async function listDocumentBlocklist(): Promise<DocumentBlocklistEntry[]> {
  const db = await getDatabase();
  return db
    .prepare(
      "SELECT entity_id, reason, details, created_at FROM document_blocklist ORDER BY created_at",
    )
    .all() as unknown as DocumentBlocklistEntry[];
}

type RunRow = IngestRunRecord;

export async function getRunIssueCount(runId: string): Promise<number> {
  const db = await getDatabase();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM ingest_run_issue WHERE run_id = ?")
    .get(runId) as { count?: number } | undefined;
  return row?.count ?? 0;
}

function normalizeTrigger(trigger: string): IngestRunTrigger {
  if (
    trigger === "scheduled" ||
    trigger === "user" ||
    trigger === "manual" ||
    trigger === "api" ||
    trigger === "backfill"
  ) {
    return trigger;
  }

  return "user";
}

function normalizeExecutionMode(mode: string): IngestExecutionMode {
  if (
    mode === "full" ||
    mode === "rederive_cached" ||
    mode === "reindex_only" ||
    mode === "motions_only" ||
    mode === "media_only" ||
    mode === "retry_failed_documents"
  ) {
    return mode;
  }

  return "full";
}

function normalizeRunRecord(record: IngestRunRecord): IngestRunRecord {
  return {
    ...record,
    trigger: normalizeTrigger(record.trigger),
    execution_mode: normalizeExecutionMode(record.execution_mode),
  };
}

function sqliteCreateRunParams(record: IngestRunRecord): Record<string, string | number | null> {
  return {
    id: record.id,
    source_key: record.source_key,
    supplier: record.supplier,
    date_from: record.date_from,
    date_to: record.date_to,
    trigger: record.trigger,
    status: record.status,
    started_at: record.started_at,
    execution_mode: record.execution_mode,
    parent_run_id: record.parent_run_id ?? null,
    projection_version: record.projection_version ?? null,
    derivation_version: record.derivation_version ?? null,
    meeting_count: record.meeting_count,
    document_count: record.document_count,
    motion_count: record.motion_count ?? 0,
    recording_count: record.recording_count ?? 0,
    cache_hits: record.cache_hits,
    downloaded_count: record.downloaded_count,
    issue_count: record.issue_count,
  };
}

function sqliteUpdateRunParams(record: IngestRunRecord): Record<string, string | number | null> {
  return {
    id: record.id,
    source_key: record.source_key,
    supplier: record.supplier,
    date_from: record.date_from,
    date_to: record.date_to,
    trigger: record.trigger,
    execution_mode: record.execution_mode,
    parent_run_id: record.parent_run_id ?? null,
    projection_version: record.projection_version ?? null,
    derivation_version: record.derivation_version ?? null,
    status: record.status,
    started_at: record.started_at,
    finished_at: record.finished_at ?? null,
    meeting_count: record.meeting_count,
    document_count: record.document_count,
    motion_count: record.motion_count ?? 0,
    recording_count: record.recording_count ?? 0,
    cache_hits: record.cache_hits,
    downloaded_count: record.downloaded_count,
    issue_count: record.issue_count,
    quickwit_index_id: record.quickwit_index_id ?? null,
    error_message: record.error_message ?? null,
  };
}

export async function createRun(
  run: Omit<
    IngestRunRecord,
    | "id"
    | "started_at"
    | "status"
    | "meeting_count"
    | "document_count"
    | "motion_count"
    | "recording_count"
    | "cache_hits"
    | "downloaded_count"
    | "issue_count"
  > & { status?: IngestRunRecord["status"] },
): Promise<IngestRunRecord> {
  const db = await getDatabase();
  const record: IngestRunRecord = {
    id: crypto.randomUUID(),
    source_key: run.source_key,
    supplier: run.supplier,
    date_from: run.date_from,
    date_to: run.date_to,
    trigger: run.trigger,
    execution_mode: run.execution_mode,
    parent_run_id: run.parent_run_id,
    projection_version: run.projection_version,
    derivation_version: run.derivation_version,
    status: run.status ?? "running",
    started_at: new Date().toISOString(),
    meeting_count: 0,
    document_count: 0,
    motion_count: 0,
    recording_count: 0,
    cache_hits: 0,
    downloaded_count: 0,
    issue_count: 0,
  };

  db.prepare(
    `INSERT INTO ingest_run (
      id, source_key, supplier, date_from, date_to, trigger_mode, status, started_at,
      execution_mode, parent_run_id, projection_version, derivation_version,
      meeting_count, document_count, cache_hits, downloaded_count, issue_count, motion_count,
      recording_count
    ) VALUES (
      @id, @source_key, @supplier, @date_from, @date_to, @trigger, @status, @started_at,
      @execution_mode, @parent_run_id, @projection_version, @derivation_version,
      @meeting_count, @document_count, @cache_hits, @downloaded_count, @issue_count, @motion_count,
      @recording_count
    )`,
  ).run(sqliteCreateRunParams(record));

  return normalizeRunRecord(record);
}

export async function updateRun(
  runId: string,
  patch: Partial<IngestRunRecord>,
): Promise<IngestRunRecord> {
  const current = await getRunDetails(runId);
  if (!current) {
    throw new Error(`Unknown run ${runId}`);
  }

  const updated: IngestRunRecord = {
    ...current.run,
    ...patch,
  };

  const db = await getDatabase();
  db.prepare(
    `UPDATE ingest_run SET
      source_key=@source_key,
      supplier=@supplier,
      date_from=@date_from,
      date_to=@date_to,
      trigger_mode=@trigger,
      execution_mode=@execution_mode,
      parent_run_id=@parent_run_id,
      projection_version=@projection_version,
      derivation_version=@derivation_version,
      status=@status,
      started_at=@started_at,
      finished_at=@finished_at,
      meeting_count=@meeting_count,
      document_count=@document_count,
      motion_count=@motion_count,
      recording_count=@recording_count,
      cache_hits=@cache_hits,
      downloaded_count=@downloaded_count,
      issue_count=@issue_count,
      quickwit_index_id=@quickwit_index_id,
      error_message=@error_message
    WHERE id=@id`,
  ).run(sqliteUpdateRunParams(updated));

  return normalizeRunRecord(updated);
}

export async function appendRunIssue(runId: string, issue: ExtractionIssue): Promise<void> {
  const db = await getDatabase();
  db.prepare(
    `INSERT INTO ingest_run_issue (id, run_id, severity, step, entity_id, message, details)
     VALUES (@id, @run_id, @severity, @step, @entity_id, @message, @details)`,
  ).run({
    id: crypto.randomUUID(),
    run_id: runId,
    severity: issue.severity,
    step: issue.step,
    entity_id: issue.entity_id ?? null,
    message: issue.message,
    details: issue.details ?? null,
  });
}

export async function findActiveRun(options: {
  sourceKey: string;
  dateFrom: string;
  dateTo: string;
  executionMode: IngestExecutionMode;
}): Promise<IngestRunRecord | null> {
  const db = await getDatabase();
  const run = db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       WHERE source_key = @source_key
         AND date_from = @date_from
         AND date_to = @date_to
         AND execution_mode = @execution_mode
         AND status IN ('queued', 'running')
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get({
      source_key: options.sourceKey,
      date_from: options.dateFrom,
      date_to: options.dateTo,
      execution_mode: options.executionMode,
    }) as RunRow | undefined;

  return run ? normalizeRunRecord(run) : null;
}

export async function countActiveScheduledRuns(): Promise<number> {
  const db = await getDatabase();
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM ingest_run
       WHERE trigger_mode = 'scheduled'
         AND execution_mode = 'full'
         AND status IN ('queued', 'running')`,
    )
    .get() as { count?: number } | undefined;
  return row?.count ?? 0;
}

/** How often a run may be requeued after a process restart before it is
 * declared failed. The cap prevents a run that reliably kills the process
 * (e.g. OOM) from crash-looping across restarts forever — but restarts are
 * usually external (deploys, and since July 2026 the monitor's fd-leak
 * self-heal, which fired hourly during backfill bursts and permanently
 * failed 288 healthy runs at the old cap of 2). Five tolerates a bad night
 * of restarts while still catching a genuine crash-looper. */
const MAX_INTERRUPTED_REQUEUES = 5;

/** Runs claimed more recently than this are left alone by reconcile: with
 * two worker replicas restarting seconds apart (a deploy), the second one to
 * boot would otherwise requeue rows its sibling just claimed, and the same
 * run ends up executing twice concurrently (seen July 2026: duplicate
 * failures and phantom stalls for the same run id).
 *
 * The age is that of the claim, `claimed_at`, not of the row. `started_at` is
 * set when the run is enqueued, and a backfill chunk can sit in the queue for
 * hours before a worker takes it; judged by `started_at` such a claim looked
 * ancient the moment it was made. Seen 2026-09-05: after a restart three of
 * four workers each requeued and re-claimed the same eight runs within one
 * second, and executed them in triplicate for an hour. Rows claimed before
 * this column existed carry no `claimed_at` and fall back to `started_at`. */
const RECONCILE_MIN_CLAIM_AGE_MS = 120_000;

export async function reconcileInterruptedRuns(): Promise<IngestRunRecord[]> {
  const db = await getDatabase();
  const claimedBefore = new Date(Date.now() - RECONCILE_MIN_CLAIM_AGE_MS).toISOString();
  const interruptedRuns = db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
        issue_count, quickwit_index_id, error_message, interrupted_count
       FROM ingest_run
       WHERE status = 'running' AND COALESCE(claimed_at, started_at) < ?
       ORDER BY started_at ASC`,
    )
    .all(claimedBefore) as unknown as (RunRow & { interrupted_count: number | null })[];

  if (interruptedRuns.length === 0) {
    return [];
  }

  const finishedAt = new Date().toISOString();
  const message = "Process terminated before completion.";
  const requeueStatement = db.prepare(
    `UPDATE ingest_run SET
      status = 'queued',
      finished_at = NULL,
      error_message = NULL,
      interrupted_count = COALESCE(interrupted_count, 0) + 1
    WHERE id = @id`,
  );
  const failStatement = db.prepare(
    `UPDATE ingest_run SET
      status = 'failed',
      finished_at = @finished_at,
      error_message = COALESCE(error_message, @error_message),
      issue_count = (
        SELECT COUNT(*)
        FROM ingest_run_issue
        WHERE run_id = @id
      ) + 1
    WHERE id = @id`,
  );
  const insertIssueStatement = db.prepare(
    `INSERT INTO ingest_run_issue (id, run_id, severity, step, entity_id, message, details)
     VALUES (@id, @run_id, @severity, @step, @entity_id, @message, @details)`,
  );

  const reconciled: IngestRunRecord[] = [];
  try {
    db.exec("BEGIN");
    for (const run of interruptedRuns) {
      const interruptedCount = run.interrupted_count ?? 0;
      // A restart (usually a deploy) interrupted this run through no fault of
      // its own: put it back in the queue instead of dropping it as failed —
      // backfill chunks are never re-enqueued by the daily scheduler, so a
      // failed drop would silently leave a hole in the history.
      if (interruptedCount < MAX_INTERRUPTED_REQUEUES) {
        requeueStatement.run({ id: run.id });
        insertIssueStatement.run({
          id: crypto.randomUUID(),
          run_id: run.id,
          severity: "warning",
          step: "ingest_quickwit",
          entity_id: null,
          message: `Interrupted by a process restart; requeued (attempt ${interruptedCount + 1}/${MAX_INTERRUPTED_REQUEUES}).`,
          details: "Automatically reconciled on startup after the previous process exited.",
        });
        reconciled.push(
          normalizeRunRecord({
            ...run,
            status: "queued",
            finished_at: undefined,
            error_message: undefined,
          }),
        );
        continue;
      }

      failStatement.run({
        id: run.id,
        finished_at: finishedAt,
        error_message: message,
      });
      insertIssueStatement.run({
        id: crypto.randomUUID(),
        run_id: run.id,
        severity: "error",
        step: "ingest_quickwit",
        entity_id: null,
        message: `${message} Not requeued: already interrupted ${interruptedCount} times.`,
        details:
          "Automatically reconciled on startup after the previous process exited unexpectedly.",
      });
      reconciled.push(
        normalizeRunRecord({
          ...run,
          status: "failed",
          finished_at: finishedAt,
          issue_count: run.issue_count + 1,
          error_message: run.error_message ?? message,
        }),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures; surface the original reconciliation error.
    }
    throw error;
  }

  return reconciled;
}

// Atomically move a queued run to "running". Multiple workers can race on
// the same queued id; only one succeeds. The loser gets null and must try
// another run. Requires SQLite >= 3.35 for UPDATE ... RETURNING.
/** Take a queued run for this process. Atomic: the status guard in the
 * UPDATE means at most one caller gets the row back. The claim is stamped so
 * a sibling's startup reconcile can tell a run that is being worked on from
 * one whose worker died (see RECONCILE_MIN_CLAIM_AGE_MS). */
export async function claimQueuedRun(runId: string): Promise<IngestRunRecord | null> {
  const db = await getDatabase();
  const row = db
    .prepare(
      `UPDATE ingest_run
       SET status = 'running', error_message = NULL, claimed_at = @claimed_at
       WHERE id = @id AND status = 'queued'
       RETURNING id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
         execution_mode, parent_run_id, projection_version, derivation_version, status,
         started_at, finished_at, meeting_count, document_count, cache_hits, motion_count,
         recording_count, downloaded_count, issue_count, quickwit_index_id, error_message`,
    )
    .get({ id: runId, claimed_at: new Date().toISOString() }) as IngestRunRecord | undefined;
  return row ? normalizeRunRecord(row) : null;
}

export async function listQueuedRuns(): Promise<IngestRunRecord[]> {
  const db = await getDatabase();
  return (
    db
      .prepare(
        `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       WHERE status = 'queued'
       ORDER BY started_at ASC`,
      )
      .all() as unknown as IngestRunRecord[]
  ).map(normalizeRunRecord);
}

export async function listRuns(
  options: {
    sourceKey?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<IngestRunRecord[]> {
  const db = await getDatabase();
  const limit = options.limit ?? 50;
  const offset = Math.max(0, options.offset ?? 0);
  const clauses: string[] = [];
  const params: Record<string, string | number> = { limit, offset };

  if (options.sourceKey) {
    clauses.push("source_key = @source_key");
    params.source_key = options.sourceKey;
  }
  if (options.status) {
    clauses.push("status = @status");
    params.status = options.status;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return (
    db
      .prepare(
        `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       ${where}
       ORDER BY started_at DESC
       LIMIT @limit
       OFFSET @offset`,
      )
      .all(params) as unknown as IngestRunRecord[]
  ).map(normalizeRunRecord);
}

/** The newest run per source, plus that source's newest *successful* run.
 * Both are needed: the newest run says what is happening now, the newest
 * success says whether it matters. */
export interface SourceRunStatus {
  sourceKey: string;
  supplier: string;
  lastRunAt?: string;
  lastRunStatus?: IngestRunRecord["status"];
  lastErrorMessage?: string;
  lastSuccessAt?: string;
}

export interface SupplierRunWindow {
  supplier: string;
  runCount: number;
  succeededCount: number;
  failedCount: number;
  lastErrorMessage?: string;
}

export interface IngestStatusSnapshot {
  sources: SourceRunStatus[];
  supplierWindows: SupplierRunWindow[];
}

/** Only a `full` run answers "is new data arriving from the source system?".
 *
 * The other modes do not touch the supplier at all, or only a corner of it:
 * `reindex_only` replays the export log, `rederive_cached` re-reads stored
 * files, `motions_only` and `media_only` skip the meeting and document pass.
 * Counting them would be actively misleading rather than merely generous —
 * while iBabs had this server blocked, 164 iBabs sources recorded a
 * *succeeded* `reindex_only` run (2026-08-12), which is exactly the "everything
 * is fine" reading the status endpoint exists to prevent. */
const SUPPLIER_POLLING_MODE = "full";

/** Import state per source and per supplier, for the public status endpoint.
 *
 * A `partial` run counts as a success here. It means the source was reached
 * and most of it landed; the alternative reading — that a single unreadable
 * PDF marks a whole municipality as not updating — is the one that would make
 * the status page useless. */
export async function getIngestStatus(windowHours: number): Promise<IngestStatusSnapshot> {
  const db = await getDatabase();
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const latestRows = db
    .prepare(
      `SELECT source_key, supplier, status, started_at, error_message
       FROM (
         SELECT source_key, supplier, status, started_at, error_message,
                ROW_NUMBER() OVER (
                  PARTITION BY source_key ORDER BY started_at DESC, rowid DESC
                ) AS rn
         FROM ingest_run
         WHERE execution_mode = @mode
       )
       WHERE rn = 1`,
    )
    .all({ mode: SUPPLIER_POLLING_MODE }) as Array<{
    source_key: string;
    supplier: string;
    status: IngestRunRecord["status"];
    started_at: string;
    error_message: string | null;
  }>;

  const successRows = db
    .prepare(
      `SELECT source_key, MAX(COALESCE(finished_at, started_at)) AS last_success_at
       FROM ingest_run
       WHERE status IN ('succeeded', 'partial') AND execution_mode = @mode
       GROUP BY source_key`,
    )
    .all({ mode: SUPPLIER_POLLING_MODE }) as Array<{
    source_key: string;
    last_success_at: string;
  }>;

  const lastSuccessBySource = new Map(
    successRows.map((row) => [row.source_key, row.last_success_at]),
  );

  const sources: SourceRunStatus[] = latestRows.map((row) => ({
    sourceKey: row.source_key,
    supplier: row.supplier,
    lastRunAt: row.started_at,
    lastRunStatus: row.status,
    lastErrorMessage: row.error_message ?? undefined,
    lastSuccessAt: lastSuccessBySource.get(row.source_key),
  }));

  const windowRows = db
    .prepare(
      `SELECT supplier, status, COUNT(*) AS run_count
       FROM ingest_run
       WHERE started_at > @since AND execution_mode = @mode
       GROUP BY supplier, status`,
    )
    .all({ since, mode: SUPPLIER_POLLING_MODE }) as Array<{
    supplier: string;
    status: IngestRunRecord["status"];
    run_count: number;
  }>;

  const windows = new Map<string, SupplierRunWindow>();
  for (const row of windowRows) {
    const window = windows.get(row.supplier) ?? {
      supplier: row.supplier,
      runCount: 0,
      succeededCount: 0,
      failedCount: 0,
    };
    window.runCount += row.run_count;
    if (row.status === "succeeded" || row.status === "partial") {
      window.succeededCount += row.run_count;
    } else if (row.status === "failed") {
      window.failedCount += row.run_count;
    }
    windows.set(row.supplier, window);
  }

  // One representative error per supplier, taken from the newest failure in
  // the window. When a supplier is wholly down, every source carries the same
  // message; repeating it 90 times in the response helps nobody.
  const supplierErrorRows = db
    .prepare(
      `SELECT supplier, error_message
       FROM (
         SELECT supplier, error_message,
                ROW_NUMBER() OVER (
                  PARTITION BY supplier ORDER BY started_at DESC, rowid DESC
                ) AS rn
         FROM ingest_run
         WHERE status = 'failed'
           AND started_at > @since
           AND execution_mode = @mode
           AND error_message IS NOT NULL
       )
       WHERE rn = 1`,
    )
    .all({ since, mode: SUPPLIER_POLLING_MODE }) as Array<{
    supplier: string;
    error_message: string;
  }>;

  for (const row of supplierErrorRows) {
    const window = windows.get(row.supplier);
    if (window) {
      window.lastErrorMessage = row.error_message;
    }
  }

  return { sources, supplierWindows: [...windows.values()] };
}

export async function getRunSummary(): Promise<AdminRunSummary> {
  const db = await getDatabase();

  const counts = db
    .prepare(
      `SELECT status, COUNT(*) as count
       FROM ingest_run
       GROUP BY status`,
    )
    .all() as Array<{ status: IngestRunRecord["status"]; count: number }>;

  const summary: AdminRunSummary = {
    queuedCount: 0,
    runningCount: 0,
    succeededCount: 0,
    partialCount: 0,
    failedCount: 0,
  };

  for (const row of counts) {
    switch (row.status) {
      case "queued":
        summary.queuedCount = row.count;
        break;
      case "running":
        summary.runningCount = row.count;
        break;
      case "succeeded":
        summary.succeededCount = row.count;
        break;
      case "partial":
        summary.partialCount = row.count;
        break;
      case "failed":
        summary.failedCount = row.count;
        break;
    }
  }

  const currentRun = db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       WHERE status = 'running'
       ORDER BY started_at ASC
       LIMIT 1`,
    )
    .get() as RunRow | undefined;

  const oldestQueuedRun = db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       WHERE status = 'queued'
       ORDER BY started_at ASC
       LIMIT 1`,
    )
    .get() as RunRow | undefined;

  summary.currentRun = currentRun ? normalizeRunRecord(currentRun) : undefined;
  summary.oldestQueuedRun = oldestQueuedRun ? normalizeRunRecord(oldestQueuedRun) : undefined;

  return summary;
}

function monthStartLabel(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function buildCoverageMonths(monthCount: number): string[] {
  const now = new Date();
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const months: string[] = [];

  for (let index = monthCount - 1; index >= 0; index -= 1) {
    const month = new Date(currentMonth);
    month.setUTCMonth(month.getUTCMonth() - index);
    months.push(monthStartLabel(month));
  }

  return months;
}

export async function getRunCoverage(
  options: {
    monthCount?: number;
    sourceKeys?: string[];
    executionMode?: IngestExecutionMode;
    labelsBySourceKey?: Record<string, { label: string; supplier: string }>;
  } = {},
): Promise<AdminCoverageResponse> {
  const db = await getDatabase();
  const monthCount = Math.max(3, Math.min(options.monthCount ?? 12, 36));
  const months = buildCoverageMonths(monthCount);
  const firstMonth = months[0];
  const params: Record<string, string> = {
    first_month: firstMonth,
    execution_mode: options.executionMode ?? "full",
  };
  const sourceClause =
    options.sourceKeys && options.sourceKeys.length > 0
      ? `AND source_key IN (${options.sourceKeys.map((_, index) => `@source_key_${index}`).join(", ")})`
      : "";

  for (const [index, sourceKey] of (options.sourceKeys ?? []).entries()) {
    params[`source_key_${index}`] = sourceKey;
  }

  const rows = db
    .prepare(
      `SELECT
      id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
      execution_mode, parent_run_id, projection_version, derivation_version, status,
      started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
      issue_count, quickwit_index_id, error_message
     FROM ingest_run
     WHERE execution_mode = @execution_mode
       AND date_from >= @first_month
       ${sourceClause}
     ORDER BY started_at DESC`,
    )
    .all(params) as unknown as RunRow[];

  const rowsBySource = new Map<string, Map<string, AdminCoverageCell>>();
  for (const sourceKey of options.sourceKeys ?? []) {
    rowsBySource.set(sourceKey, new Map());
  }

  for (const row of rows.map(normalizeRunRecord)) {
    const month = row.date_from.slice(0, 7) + "-01";
    if (!months.includes(month)) {
      continue;
    }

    let sourceMonths = rowsBySource.get(row.source_key);
    if (!sourceMonths) {
      sourceMonths = new Map();
      rowsBySource.set(row.source_key, sourceMonths);
    }

    if (sourceMonths.has(month)) {
      continue;
    }

    sourceMonths.set(month, {
      month,
      status: row.status,
      documentCount: row.document_count,
      meetingCount: row.meeting_count,
      issueCount: row.issue_count,
      startedAt: row.started_at,
      runId: row.id,
    });
  }

  let maxDocumentCount = 0;
  const coverageRows: AdminCoverageRow[] = [...rowsBySource.entries()]
    .map(([sourceKey, sourceMonths]) => {
      const labelInfo = options.labelsBySourceKey?.[sourceKey];
      const monthCells = months.map(
        (month) =>
          sourceMonths.get(month) ?? {
            month,
            documentCount: 0,
            meetingCount: 0,
            issueCount: 0,
          },
      );
      const totalDocumentCount = monthCells.reduce((sum, cell) => sum + cell.documentCount, 0);
      const coveredMonthCount = monthCells.filter((cell) => Boolean(cell.status)).length;
      const rowMax = monthCells.reduce((max, cell) => Math.max(max, cell.documentCount), 0);
      maxDocumentCount = Math.max(maxDocumentCount, rowMax);

      return {
        sourceKey,
        label: labelInfo?.label ?? sourceKey,
        supplier: labelInfo?.supplier ?? "onbekend",
        organizationType: "onbekend",
        months: monthCells,
        totalDocumentCount,
        coveredMonthCount,
      };
    })
    .sort(
      (left, right) =>
        right.totalDocumentCount - left.totalDocumentCount ||
        right.coveredMonthCount - left.coveredMonthCount ||
        left.label.localeCompare(right.label, "nl"),
    );

  return {
    months,
    rows: coverageRows,
    maxDocumentCount,
  };
}

export async function getRunDetails(runId: string): Promise<RunDetails | null> {
  const db = await getDatabase();
  const run = db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count, motion_count, recording_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;

  if (!run) {
    return null;
  }

  const issues = db
    .prepare(
      `SELECT severity, step, entity_id, message
              , details
       FROM ingest_run_issue
       WHERE run_id = ?
       ORDER BY rowid ASC`,
    )
    .all(runId) as unknown as ExtractionIssue[];

  return { run: normalizeRunRecord(run), issues };
}

// -- Source revalidation sweep (scripts/revalidate_documents.ts) --------
//
// Tracks, per document entity, how many consecutive sweep runs found it
// genuinely gone at the source (see the script for the "genuinely gone" vs
// "unknown" classification per supplier). Only report()-able once a document
// reaches a confirmation threshold across separate runs -- a single miss is
// never enough (API hiccups, timeouts, org-wide outages must not count).

export interface RevalidationEntry {
  entity_id: string;
  supplier: string;
  source_key: string;
  url: string | null;
  streak: number;
  last_checked_at: string;
}

export async function getRevalidationCursor(supplier: string): Promise<number> {
  const db = await getDatabase();
  const row = db
    .prepare("SELECT start_offset FROM revalidation_cursor WHERE supplier = ?")
    .get(supplier) as { start_offset?: number } | undefined;
  return row?.start_offset ?? 0;
}

export async function setRevalidationCursor(supplier: string, offset: number): Promise<void> {
  const db = await getDatabase();
  db.prepare(
    `INSERT INTO revalidation_cursor (supplier, start_offset) VALUES (@supplier, @offset)
     ON CONFLICT(supplier) DO UPDATE SET start_offset = excluded.start_offset`,
  ).run({ supplier, offset });
}

/** Call once per checked document per run. status "gone" extends the streak,
 * "live" clears it (source restored it, or an earlier miss was a fluke). An
 * "unknown" result (org-wide outage, timeout, ...) must simply not be called
 * at all -- there is deliberately no way to record it here. */
export async function recordRevalidationResult(
  entityId: string,
  supplier: string,
  sourceKey: string,
  status: "gone" | "live",
  url: string | null,
): Promise<number> {
  const db = await getDatabase();
  if (status === "live") {
    db.prepare("DELETE FROM document_revalidation WHERE entity_id = ?").run(entityId);
    return 0;
  }

  const existing = db
    .prepare("SELECT streak FROM document_revalidation WHERE entity_id = ?")
    .get(entityId) as { streak?: number } | undefined;
  const streak = (existing?.streak ?? 0) + 1;
  db.prepare(
    `INSERT INTO document_revalidation (entity_id, supplier, source_key, url, streak, last_checked_at)
     VALUES (@entity_id, @supplier, @source_key, @url, @streak, @last_checked_at)
     ON CONFLICT(entity_id) DO UPDATE SET
       source_key = excluded.source_key, url = excluded.url,
       streak = excluded.streak, last_checked_at = excluded.last_checked_at`,
  ).run({
    entity_id: entityId,
    supplier,
    source_key: sourceKey,
    url,
    streak,
    last_checked_at: new Date().toISOString(),
  });
  return streak;
}

export async function listConfirmedGoneDocuments(
  supplier: string,
  threshold: number,
): Promise<RevalidationEntry[]> {
  const db = await getDatabase();
  return db
    .prepare(
      `SELECT entity_id, supplier, source_key, url, streak, last_checked_at
       FROM document_revalidation
       WHERE supplier = @supplier AND streak >= @threshold
       ORDER BY streak DESC`,
    )
    .all({ supplier, threshold }) as unknown as RevalidationEntry[];
}

/** One coverage check of one source: what the supplier listed for the window
 * against what the export log held. See src/coverage/check.ts. */
export interface CoverageCheckRecord {
  source_key: string;
  checked_at: string;
  window_from: string;
  window_to: string;
  supplier_documents: number;
  held_documents: number;
  missing_documents: number;
  missing_sample: string[];
  supplier_meetings: number;
  register_entries: number;
  /** Supplier requests that failed during the listing; the supplier count is
   * then a lower bound. */
  warnings: number;
  /** Set when the listing itself failed and the counts are meaningless. */
  error?: string;
}

export async function recordCoverageCheck(record: CoverageCheckRecord): Promise<void> {
  const db = await getDatabase();
  db.prepare(
    `INSERT INTO coverage_check (
       source_key, checked_at, window_from, window_to, supplier_documents, held_documents,
       missing_documents, missing_sample, supplier_meetings, register_entries, warnings, error
     ) VALUES (
       @source_key, @checked_at, @window_from, @window_to, @supplier_documents, @held_documents,
       @missing_documents, @missing_sample, @supplier_meetings, @register_entries, @warnings, @error
     )
     ON CONFLICT(source_key, checked_at) DO UPDATE SET
       supplier_documents = excluded.supplier_documents,
       held_documents = excluded.held_documents,
       missing_documents = excluded.missing_documents,
       missing_sample = excluded.missing_sample,
       supplier_meetings = excluded.supplier_meetings,
       register_entries = excluded.register_entries,
       warnings = excluded.warnings,
       error = excluded.error`,
  ).run({
    source_key: record.source_key,
    checked_at: record.checked_at,
    window_from: record.window_from,
    window_to: record.window_to,
    supplier_documents: record.supplier_documents,
    held_documents: record.held_documents,
    missing_documents: record.missing_documents,
    missing_sample: JSON.stringify(record.missing_sample),
    supplier_meetings: record.supplier_meetings,
    register_entries: record.register_entries,
    warnings: record.warnings,
    error: record.error ?? null,
  });
}

/** The latest check per source. */
export async function latestCoverageChecks(): Promise<CoverageCheckRecord[]> {
  const db = await getDatabase();
  const rows = db
    .prepare(
      `SELECT source_key, checked_at, window_from, window_to, supplier_documents, held_documents,
              missing_documents, missing_sample, supplier_meetings, register_entries, warnings, error
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY source_key ORDER BY checked_at DESC) AS rn
         FROM coverage_check
       ) WHERE rn = 1`,
    )
    .all() as unknown as Array<
    Omit<CoverageCheckRecord, "missing_sample" | "error"> & {
      missing_sample: string;
      error: string | null;
    }
  >;
  return rows.map((row) => ({
    ...row,
    missing_sample: JSON.parse(row.missing_sample) as string[],
    error: row.error ?? undefined,
  }));
}
