// Rewrite oversized changes segments as page-sized ones (#414).
//
// Usage:
//   deno run -A scripts/split_export_segments.ts [--apply] [sourceKey]
//
// Before flush cut a run into pages, one backfill run became one segment of
// tens of thousands of records, and every /api/export/changes page that
// touched it downloaded and scanned the whole object. This splits those into
// segments of EXPORT_SEGMENT_MAX_RECORDS covering the same seq range, so the
// feed's content and cursors stay exactly the same.
//
// Without --apply this is a dry run that lists the oversized segments.
import { EXPORT_SEGMENT_MAX_RECORDS, getExportLog } from "../src/exports/log.ts";

async function main(): Promise<void> {
  const apply = Deno.args.includes("--apply");
  const sourceKey = Deno.args.find((arg) => !arg.startsWith("--"));
  const log = await getExportLog();
  const oversized = log.listOversizedSegments(sourceKey);
  const total = oversized.reduce((sum, segment) => sum + segment.recordCount, 0);
  console.log(
    `${oversized.length} segments over ${EXPORT_SEGMENT_MAX_RECORDS} records ` +
      `(${total} records)${sourceKey ? ` for ${sourceKey}` : ""}`,
  );

  let failed = 0;
  for (const segment of oversized) {
    const label = `${segment.sourceKey} ${segment.startSeq}-${segment.endSeq} (${segment.recordCount})`;
    if (!apply) {
      console.log(`would split ${label}`);
      continue;
    }
    try {
      const parts = await log.splitSegment(segment.sourceKey, segment.startSeq);
      console.log(`split ${label} into ${parts}`);
    } catch (error) {
      failed += 1;
      console.error(`failed ${label}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (!apply) {
    console.log("dry run, pass --apply to split");
  }
  if (failed > 0) {
    Deno.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
