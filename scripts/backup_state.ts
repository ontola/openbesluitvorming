/**
 * Back up the SQLite state databases to S3-compatible object storage.
 *
 * The ops database holds the run administration and the document blocklist
 * (legally relevant: taken-down documents come back without it), the export
 * log database holds the seq/dedup state behind /api/export. Both live on a
 * single Docker volume with no other copy.
 *
 * Uses `VACUUM INTO` for a consistent snapshot of a live WAL database, gzips
 * it, uploads to `backups/sqlite/{name}/{date}.sqlite3.gz`, and prunes
 * backups older than the retention window.
 *
 * Intended to run inside the openbesluitvorming container (S3 env and volume
 * are already present):
 *
 *   docker exec woozi-openbesluitvorming-1 deno run -A scripts/backup_state.ts
 */

import { DatabaseSync } from "node:sqlite";
import { getConfigValue } from "../src/config.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

const RETENTION_DAYS = Math.max(
  1,
  Number(Deno.env.get("WOOZI_BACKUP_RETENTION_DAYS") ?? "14") || 14,
);

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Streams the snapshot straight from disk through gzip to a second file,
// instead of buffering it as a Uint8Array first: woozi-export-log.sqlite3
// has grown to several GB (July 2026 full-history backfill), and reading
// the whole thing into memory -- twice, once raw and once compressed via
// the old Blob-based gzip() -- OOM-killed the container (7.6GB host).
async function gzipFileToFile(inputPath: string, outputPath: string): Promise<void> {
  const input = await Deno.open(inputPath, { read: true });
  const output = await Deno.open(outputPath, { write: true, create: true, truncate: true });
  await input.readable.pipeThrough(new CompressionStream("gzip")).pipeTo(output.writable);
}

const storage = await ObjectStorageClient.fromEnvironment();
const today = isoDate(new Date());
const cutoff = isoDate(new Date(Date.now() - RETENTION_DAYS * 86_400_000));

const targets: Array<{ name: string; envKey: string; fallback: string }> = [
  { name: "woozi-ops", envKey: "WOOZI_KV_PATH", fallback: "./woozi-ops.sqlite3" },
  {
    name: "woozi-export-log",
    envKey: "WOOZI_EXPORT_LOG_PATH",
    fallback: "./woozi-export-log.sqlite3",
  },
];

let failures = 0;

for (const target of targets) {
  const path = await getConfigValue(target.envKey, target.fallback);
  try {
    await Deno.stat(path);
  } catch {
    console.log(
      JSON.stringify({ event: "backup_skipped", name: target.name, reason: "missing", path }),
    );
    continue;
  }
  if (path.includes("'")) {
    throw new Error(`Refusing path with quote: ${path}`);
  }

  const snapshotPath = await Deno.makeTempFile({ suffix: ".sqlite3" });
  await Deno.remove(snapshotPath); // VACUUM INTO refuses an existing file.
  const gzPath = await Deno.makeTempFile({ suffix: ".sqlite3.gz" });
  try {
    const db = new DatabaseSync(path);
    try {
      db.exec(`VACUUM INTO '${snapshotPath}'`);
    } finally {
      db.close();
    }

    await gzipFileToFile(snapshotPath, gzPath);
    const key = `backups/sqlite/${target.name}/${today}.sqlite3.gz`;
    // Multipart from disk: buffering the gzip in memory OOM-killed the
    // container (exit 137) once the export log passed a few GB.
    await storage.putObjectFromFile(key, gzPath, { contentType: "application/gzip" });
    console.log(
      JSON.stringify({
        event: "backup_uploaded",
        name: target.name,
        key,
        bytes: (await Deno.stat(gzPath)).size,
      }),
    );

    // Prune: keys are `{prefix}/{YYYY-MM-DD}.sqlite3.gz`, so a string compare
    // against the cutoff date is a correct age test.
    const prefix = `backups/sqlite/${target.name}/`;
    const { keys } = await storage.listObjects({ prefix, maxKeys: 1000 });
    const stale = keys.filter((key) => {
      const date = key.slice(prefix.length, prefix.length + 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff;
    });
    if (stale.length > 0) {
      await storage.deleteObjects(stale);
      console.log(
        JSON.stringify({ event: "backup_pruned", name: target.name, removed: stale.length }),
      );
    }
  } catch (error) {
    failures += 1;
    console.error(
      JSON.stringify({
        event: "backup_failed",
        name: target.name,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    await Deno.remove(snapshotPath).catch(() => undefined);
    await Deno.remove(gzPath).catch(() => undefined);
  }
}

if (failures > 0) {
  Deno.exit(1);
}

// Freshness stamp next to the ops database; the production monitor alerts
// when this file goes stale, so a silently failing backup timer still pages.
const opsPath = await getConfigValue("WOOZI_KV_PATH", "./woozi-ops.sqlite3");
const stampPath = `${opsPath.slice(0, opsPath.lastIndexOf("/") + 1)}.woozi-backup-stamp`;
await Deno.writeTextFile(stampPath, new Date().toISOString());
