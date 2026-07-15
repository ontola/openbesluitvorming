import { DatabaseSync } from "node:sqlite";
import { getConfigValue } from "../config.ts";
import { compactEntityPayload } from "../quickwit/project.ts";
import { ObjectStorageClient } from "../storage/s3.ts";
import type { EntityCommitEvent, ExportChangeRecord, ExportPage, WooziEntity } from "../types.ts";

export const EXPORT_BATCH_LIMIT_MAX = 1000;
export const EXPORT_BATCH_LIMIT_DEFAULT = 500;

/** Structural subset of ObjectStorageClient so tests can use an in-memory fake. */
export interface ExportSegmentStorage {
  putObject(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<unknown>;
  getObjectText(key: string): Promise<string>;
}

export interface ExportSnapshotPage extends ExportPage {
  /** Cursor to start following /changes from after consuming this snapshot.
   * Take the value from the FIRST page: it is captured before the page rows
   * are read, so replaying changes from it cannot miss concurrent writes. */
  changesCursor: string;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return EXPORT_BATCH_LIMIT_DEFAULT;
  }
  return Math.max(1, Math.min(Math.floor(value as number), EXPORT_BATCH_LIMIT_MAX));
}

export function parseChangesCursor(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid changes cursor: ${value}`);
  }
  return parsed;
}

function padSeq(seq: number): string {
  return String(seq).padStart(12, "0");
}

/**
 * Append-only, per-source export changes log.
 *
 * Entity commits are deduplicated on content_hash (a re-ingest of unchanged
 * data appends nothing), assigned a per-source monotonic sequence number, and
 * buffered in SQLite (`export_pending`). `flush()` publishes buffered records
 * as immutable NDJSON segment objects in object storage and registers them in
 * `export_segment`. Unflushed records are still served (pending tail), so a
 * crash before flush loses nothing.
 *
 * `export_entity_state` keeps the latest record per entity, which makes the
 * snapshot endpoint a simple ordered scan.
 */
export class ExportChangesLog {
  private readonly db: DatabaseSync;
  private readonly storage: ExportSegmentStorage;
  private readonly flushLocks = new Map<string, Promise<unknown>>();

  constructor(options: { db: DatabaseSync; storage: ExportSegmentStorage }) {
    this.db = options.db;
    this.storage = options.storage;
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS export_head (
        source_key TEXT PRIMARY KEY,
        next_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS export_entity_state (
        source_key TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        content_hash TEXT,
        seq INTEGER NOT NULL,
        op TEXT NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (source_key, entity_id)
      );
      CREATE TABLE IF NOT EXISTS export_pending (
        source_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (source_key, seq)
      );
      CREATE TABLE IF NOT EXISTS export_segment (
        source_key TEXT NOT NULL,
        start_seq INTEGER NOT NULL,
        end_seq INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_key, start_seq)
      );
    `);
  }

  /** Number of distinct live (non-deleted) entities whose id starts with the
   * prefix, e.g. "document:". Unlike the Quickwit index — which holds one row
   * per commit and re-commits the same entity on every run that touches it
   * (measured 3.5x duplication, July 2026) — this table is keyed per entity,
   * so the count is deduplicated by construction. */
  countLiveEntities(idPrefix: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM export_entity_state
         WHERE entity_id LIKE ? AND op != 'delete'`,
      )
      .get(`${idPrefix}%`) as { count?: number } | undefined;
    return row?.count ?? 0;
  }

  /** Record an entity commit. Returns the appended record, or null when the
   * commit is a no-op (content_hash unchanged since the previous record). */
  recordCommit(event: EntityCommitEvent<WooziEntity>): ExportChangeRecord | null {
    const record: ExportChangeRecord = {
      seq: 0,
      op: event.data.op,
      time: event.time,
      entity_id: event.data.entity_id,
      entity_type: event.data.entity_type,
      source_key: event.data.source.source,
      supplier: event.data.source.supplier,
      commit_id: event.data.commit_id,
      content_hash: event.data.content_hash,
      schema_version: event.data.schema_version,
      payload: event.data.op === "delete" ? undefined : compactEntityPayload(event.data.payload),
    };
    return this.append(record);
  }

  /** Record a tombstone for an entity that disappeared at the source or was
   * taken down. Deduplicated: deleting an already-deleted (or never-seen)
   * entity appends nothing. */
  recordDelete(options: {
    sourceKey: string;
    supplier: string;
    entityId: string;
    entityType: string;
    time?: string;
  }): ExportChangeRecord | null {
    return this.append({
      seq: 0,
      op: "delete",
      time: options.time ?? new Date().toISOString(),
      entity_id: options.entityId,
      entity_type: options.entityType,
      source_key: options.sourceKey,
      supplier: options.supplier,
    });
  }

  private append(record: ExportChangeRecord): ExportChangeRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT content_hash, op FROM export_entity_state WHERE source_key = ? AND entity_id = ?",
        )
        .get(record.source_key, record.entity_id) as
        | { content_hash: string | null; op: string }
        | undefined;

      if (record.op === "delete") {
        if (!existing || existing.op === "delete") {
          this.db.exec("ROLLBACK");
          return null;
        }
      } else if (
        existing &&
        existing.op === "upsert" &&
        existing.content_hash === record.content_hash
      ) {
        this.db.exec("ROLLBACK");
        return null;
      }

      const head = this.db
        .prepare("SELECT next_seq FROM export_head WHERE source_key = ?")
        .get(record.source_key) as { next_seq: number } | undefined;
      const seq = head?.next_seq ?? 0;
      const appended: ExportChangeRecord = { ...record, seq };
      const serialized = JSON.stringify(appended);

      this.db
        .prepare(
          `INSERT INTO export_head (source_key, next_seq) VALUES (?, ?)
           ON CONFLICT(source_key) DO UPDATE SET next_seq = excluded.next_seq`,
        )
        .run(record.source_key, seq + 1);
      this.db
        .prepare("INSERT INTO export_pending (source_key, seq, record) VALUES (?, ?, ?)")
        .run(record.source_key, seq, serialized);
      this.db
        .prepare(
          `INSERT INTO export_entity_state (source_key, entity_id, content_hash, seq, op, record)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_key, entity_id) DO UPDATE SET
             content_hash = excluded.content_hash,
             seq = excluded.seq,
             op = excluded.op,
             record = excluded.record`,
        )
        .run(
          record.source_key,
          record.entity_id,
          record.content_hash ?? null,
          seq,
          record.op,
          serialized,
        );

      this.db.exec("COMMIT");
      return appended;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Publish all pending records for a source as one immutable NDJSON segment
   * object. Safe to call when nothing is pending. Serialized per source so
   * concurrent runs cannot publish overlapping segments. */
  async flush(sourceKey: string): Promise<{ recordCount: number; objectKey?: string }> {
    const previous = this.flushLocks.get(sourceKey) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.flushNow(sourceKey));
    this.flushLocks.set(sourceKey, task);
    try {
      return await task;
    } finally {
      if (this.flushLocks.get(sourceKey) === task) {
        this.flushLocks.delete(sourceKey);
      }
    }
  }

  private async flushNow(sourceKey: string): Promise<{ recordCount: number; objectKey?: string }> {
    const rows = this.db
      .prepare("SELECT seq, record FROM export_pending WHERE source_key = ? ORDER BY seq")
      .all(sourceKey) as Array<{ seq: number; record: string }>;
    if (rows.length === 0) {
      return { recordCount: 0 };
    }

    const startSeq = rows[0].seq;
    const endSeq = rows[rows.length - 1].seq;
    const objectKey = `exports/${sourceKey}/changes/${padSeq(startSeq)}-${padSeq(endSeq)}.ndjson`;
    const body = rows.map((row) => row.record).join("\n") + "\n";
    await this.storage.putObject(objectKey, new TextEncoder().encode(body), {
      contentType: "application/x-ndjson",
    });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO export_segment (source_key, start_seq, end_seq, object_key, record_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_key, start_seq) DO UPDATE SET
             end_seq = excluded.end_seq,
             object_key = excluded.object_key,
             record_count = excluded.record_count,
             created_at = excluded.created_at`,
        )
        .run(sourceKey, startSeq, endSeq, objectKey, rows.length, new Date().toISOString());
      this.db
        .prepare("DELETE FROM export_pending WHERE source_key = ? AND seq <= ?")
        .run(sourceKey, endSeq);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { recordCount: rows.length, objectKey };
  }

  private headNextSeq(sourceKey: string): number {
    const head = this.db
      .prepare("SELECT next_seq FROM export_head WHERE source_key = ?")
      .get(sourceKey) as { next_seq: number } | undefined;
    return head?.next_seq ?? 0;
  }

  /** Read change records with seq >= cursor, oldest first, from published
   * segments plus the unflushed pending tail. */
  async readChanges(
    sourceKey: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<ExportPage> {
    const cursor = parseChangesCursor(options.cursor);
    const limit = clampLimit(options.limit);
    const records: ExportChangeRecord[] = [];

    const segments = this.db
      .prepare(
        `SELECT object_key FROM export_segment
         WHERE source_key = ? AND end_seq >= ? ORDER BY start_seq`,
      )
      .all(sourceKey, cursor) as Array<{ object_key: string }>;

    for (const segment of segments) {
      if (records.length >= limit) {
        break;
      }
      const text = await this.storage.getObjectText(segment.object_key);
      for (const line of text.split("\n")) {
        if (records.length >= limit) {
          break;
        }
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const record = JSON.parse(trimmed) as ExportChangeRecord;
        if (record.seq < cursor) {
          continue;
        }
        records.push(record);
      }
    }

    if (records.length < limit) {
      const fromSeq = records.length > 0 ? records[records.length - 1].seq + 1 : cursor;
      const pendingRows = this.db
        .prepare(
          `SELECT record FROM export_pending
           WHERE source_key = ? AND seq >= ? ORDER BY seq LIMIT ?`,
        )
        .all(sourceKey, fromSeq, limit - records.length) as Array<{ record: string }>;
      for (const row of pendingRows) {
        records.push(JSON.parse(row.record) as ExportChangeRecord);
      }
    }

    const nextCursor = records.length > 0 ? records[records.length - 1].seq + 1 : cursor;
    return {
      records,
      nextCursor: String(nextCursor),
      hasMore: nextCursor < this.headNextSeq(sourceKey),
    };
  }

  /** Read the current state per entity (latest upsert record, tombstones
   * excluded), ordered by entity_id. Cursor is the last entity_id of the
   * previous page. */
  readSnapshot(
    sourceKey: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): ExportSnapshotPage {
    const limit = clampLimit(options.limit);
    const afterEntityId = options.cursor ?? "";
    const changesCursor = String(this.headNextSeq(sourceKey));

    const rows = this.db
      .prepare(
        `SELECT entity_id, record FROM export_entity_state
         WHERE source_key = ? AND op = 'upsert' AND entity_id > ?
         ORDER BY entity_id LIMIT ?`,
      )
      .all(sourceKey, afterEntityId, limit + 1) as Array<{ entity_id: string; record: string }>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const records = page.map((row) => JSON.parse(row.record) as ExportChangeRecord);
    const nextCursor = page.length > 0 ? page[page.length - 1].entity_id : afterEntityId;

    return { records, nextCursor, hasMore, changesCursor };
  }
}

let exportLogPromise: Promise<ExportChangesLog> | null = null;

/** Shared export log wired to the configured SQLite path and object storage.
 * Used by both the ingest worker (writes) and the web server (reads). */
export function getExportLog(): Promise<ExportChangesLog> {
  if (!exportLogPromise) {
    exportLogPromise = (async () => {
      const path = await getConfigValue("WOOZI_EXPORT_LOG_PATH", "./woozi-export-log.sqlite3");
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (directory) {
        await Deno.mkdir(directory, { recursive: true }).catch(() => undefined);
      }
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode=WAL");
      const storage = await ObjectStorageClient.fromEnvironment();
      return new ExportChangesLog({ db, storage });
    })();
  }
  return exportLogPromise;
}
