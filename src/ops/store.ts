import { DatabaseSync } from "node:sqlite";
import { getConfigValue } from "../config.ts";
import type {
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
      return db;
    })();
  }

  return await databasePromise;
}

export interface RunDetails {
  run: IngestRunRecord;
  issues: ExtractionIssue[];
}

function normalizeTrigger(trigger: string): IngestRunTrigger {
  if (trigger === "scheduled" || trigger === "user" || trigger === "manual" || trigger === "api") {
    return trigger;
  }

  return "user";
}

function normalizeExecutionMode(mode: string): IngestExecutionMode {
  if (
    mode === "full" ||
    mode === "rederive_cached" ||
    mode === "reindex_only" ||
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
    | "cache_hits"
    | "downloaded_count"
    | "issue_count"
  >,
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
    status: "running",
    started_at: new Date().toISOString(),
    meeting_count: 0,
    document_count: 0,
    cache_hits: 0,
    downloaded_count: 0,
    issue_count: 0,
  };

  db.prepare(
    `INSERT INTO ingest_run (
      id, source_key, supplier, date_from, date_to, trigger_mode, status, started_at,
      execution_mode, parent_run_id, projection_version, derivation_version,
      meeting_count, document_count, cache_hits, downloaded_count, issue_count
    ) VALUES (
      @id, @source_key, @supplier, @date_from, @date_to, @trigger, @status, @started_at,
      @execution_mode, @parent_run_id, @projection_version, @derivation_version,
      @meeting_count, @document_count, @cache_hits, @downloaded_count, @issue_count
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

export async function listRuns(
  options: {
    sourceKey?: string;
    status?: string;
    limit?: number;
  } = {},
): Promise<IngestRunRecord[]> {
  const db = await getDatabase();
  const limit = options.limit ?? 50;
  const clauses: string[] = [];
  const params: Record<string, string | number> = { limit };

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
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       ${where}
       ORDER BY started_at DESC
       LIMIT @limit`,
      )
      .all(params) as IngestRunRecord[]
  ).map(normalizeRunRecord);
}

export async function getRunDetails(runId: string): Promise<RunDetails | null> {
  const db = await getDatabase();
  const run = db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger,
        execution_mode, parent_run_id, projection_version, derivation_version, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       WHERE id = ?`,
    )
    .get(runId) as IngestRunRecord | undefined;

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
    .all(runId) as ExtractionIssue[];

  return { run: normalizeRunRecord(run), issues };
}
