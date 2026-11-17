/**
 * Generate sitemap.xml for search engines (#206).
 *
 * Walks the export log per organization, keeps the meetings and documents of
 * the last N months, and writes one sitemap per organization plus an index to
 * object storage under `sitemaps/`. The web container serves them as
 * `/sitemap.xml` and `/sitemaps/<name>.xml`. Files are written first and the
 * index last, so a crawler never sees an index that names a file not there yet.
 * An organization that has no entries any more keeps its old files in storage
 * but drops out of the index.
 *
 * Usage:
 *   deno run -A scripts/generate_sitemaps.ts                 # every source, last 12 months
 *   deno run -A scripts/generate_sitemaps.ts --months 24
 *   deno run -A scripts/generate_sitemaps.ts --source ermelo
 *   deno run -A scripts/generate_sitemaps.ts --dry-run       # count, write nothing
 *
 * Runs daily on production from a systemd timer
 * (scripts/install-production-sitemaps.sh). A single `--source` run rewrites
 * only that organization's files and leaves the index alone.
 */
import { parseArgs } from "node:util";
import { getExportLog } from "../src/exports/log.ts";
import {
  buildSourceSitemaps,
  collectSitemapEntries,
  DEFAULT_PUBLIC_BASE_URL,
  renderSitemapIndex,
  SITEMAP_INDEX_KEY,
  SITEMAP_PREFIX,
  windowStart,
} from "../src/exports/sitemap.ts";
import { listSources } from "../src/sources/index.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

const args = parseArgs({
  args: Deno.args,
  options: {
    source: { type: "string" },
    months: { type: "string", default: "12" },
    "dry-run": { type: "boolean", default: false },
  },
}).values;

const months = Number(args.months);
if (!Number.isInteger(months) || months <= 0) {
  console.error(`--months must be a positive integer, got ${JSON.stringify(args.months)}`);
  Deno.exit(2);
}

const baseUrl = Deno.env.get("WOOZI_PUBLIC_BASE_URL") ?? DEFAULT_PUBLIC_BASE_URL;
const dryRun = args["dry-run"];
const sources = listSources().filter((source) => !args.source || source.key === args.source);
if (sources.length === 0) {
  console.error("No sources match.");
  Deno.exit(2);
}

const log = await getExportLog();
const storage = dryRun ? undefined : await ObjectStorageClient.fromEnvironment();
const since = windowStart(new Date(), months);
const indexFiles: Array<{ name: string; lastmod: string }> = [];
let totalUrls = 0;
const startedAt = Date.now();

for (const source of sources) {
  // Streamed, never spread into an array: a large source holds hundreds of
  // thousands of records and only the few in the window are kept.
  function* records() {
    yield* log.iterateLiveRecords(source.key, "meeting:");
    yield* log.iterateLiveRecords(source.key, "document:");
  }
  const files = buildSourceSitemaps(baseUrl, source.key, collectSitemapEntries(records(), since));
  const urlCount = files.reduce((sum, file) => sum + file.urlCount, 0);
  totalUrls += urlCount;
  console.log(`${source.key}: ${urlCount} addresses in ${files.length} file(s)`);
  for (const file of files) {
    indexFiles.push({ name: file.name, lastmod: file.lastmod });
    await storage?.putObject(`${SITEMAP_PREFIX}${file.name}`, new TextEncoder().encode(file.xml), {
      contentType: "application/xml; charset=utf-8",
    });
  }
}

if (!args.source) {
  indexFiles.sort((a, b) => a.name.localeCompare(b.name));
  await storage?.putObject(
    SITEMAP_INDEX_KEY,
    new TextEncoder().encode(renderSitemapIndex(baseUrl, indexFiles)),
    { contentType: "application/xml; charset=utf-8" },
  );
}
console.log(
  `${dryRun ? "Would write" : "Wrote"} ${totalUrls} addresses in ${indexFiles.length} files for ` +
    `${sources.length} sources (since ${since}) in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
);
