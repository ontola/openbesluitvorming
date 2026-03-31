import { DatabaseSync } from "node:sqlite";
import { getConfigValue } from "../config.ts";
import type { ExtractionIssue, IngestRunRecord } from "../types.ts";

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
          FOREIGN KEY(run_id) REFERENCES ingest_run(id)
        );
      `);
      return db;
    })();
  }

  return await databasePromise;
}

export interface RunDetails {
  run: IngestRunRecord;
  issues: ExtractionIssue[];
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
      meeting_count, document_count, cache_hits, downloaded_count, issue_count
    ) VALUES (
      @id, @source_key, @supplier, @date_from, @date_to, @trigger, @status, @started_at,
      @meeting_count, @document_count, @cache_hits, @downloaded_count, @issue_count
    )`,
  ).run(record);

  return record;
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
  ).run(updated);

  return updated;
}

export async function appendRunIssue(runId: string, issue: ExtractionIssue): Promise<void> {
  const db = await getDatabase();
  db.prepare(
    `INSERT INTO ingest_run_issue (id, run_id, severity, step, entity_id, message)
     VALUES (@id, @run_id, @severity, @step, @entity_id, @message)`,
  ).run({
    id: crypto.randomUUID(),
    run_id: runId,
    ...issue,
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
  return db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger, status,
        started_at, finished_at, meeting_count, document_count, cache_hits, downloaded_count,
        issue_count, quickwit_index_id, error_message
       FROM ingest_run
       ${where}
       ORDER BY started_at DESC
       LIMIT @limit`,
    )
    .all(params) as IngestRunRecord[];
}

export async function getRunDetails(runId: string): Promise<RunDetails | null> {
  const db = await getDatabase();
  const run = db
    .prepare(
      `SELECT
        id, source_key, supplier, date_from, date_to, trigger_mode as trigger, status,
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
       FROM ingest_run_issue
       WHERE run_id = ?
       ORDER BY rowid ASC`,
    )
    .all(runId) as ExtractionIssue[];

  return { run, issues };
}
