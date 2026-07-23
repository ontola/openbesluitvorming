// Periodic revalidation sweep: checks whether documents OpenBesluitvorming
// still serves have actually been removed at the source (iBabs / Notubiz),
// WITHOUT re-downloading anything -- just a cheap existence check against
// the source API/CDN.
//
// Usage:
//   deno run -A scripts/revalidate_documents.ts --supplier ibabs --limit 500
//   deno run -A scripts/revalidate_documents.ts --supplier notubiz --limit 500
//   deno run -A scripts/revalidate_documents.ts --supplier ibabs --report-only
//
// Design (mirrors local_scripts/revalidate_source.py, built for ori3, see
// that file's history for the calibration story -- Steenwijkerland 2026-07):
//   - Never trust a single miss. Only whitelisted, calibrated "definitely
//     gone" responses count; anything else (timeout, 5xx, unexpected status)
//     is "unknown" and is neither a hit nor a miss.
//   - Distinguish an org-wide outage from real per-document deletions by
//     SHAPE, not a global percentage: if (almost) 100% of one source_key's
//     documents come back "gone" in a run, that's a technical problem, not a
//     privacy decision -- skip recording misses for that source_key this run
//     and warn instead. A mix of live and gone within one source_key is
//     trusted and processed normally, however high the gone ratio.
//   - Require several consecutive gone-runs (CONFIRM_THRESHOLD) before a
//     document is reported as confirmed-gone.
//   - This script NEVER deletes anything. It only reports entity ids that
//     reached the confirmation threshold, for manual review and (if
//     legitimate) manual deletion via scripts/delete_document.ts.
//
// Calibrated "definitely gone" signals (tested 2026-07-23 against known live
// and known-gone documents, using OpenBesluitvorming's own original_url
// shapes -- these differ from ori3's, so ori3's calibration does NOT
// transfer as-is):
//   - iBabs (PublicDownloadURL, same publicdownload.aspx endpoint as ori3):
//     HTTP 403 or 404 = gone. HTTP 200 = live. Anything else = unknown.
//   - Notubiz (canonicalDocumentDownloadUrl, api.notubiz.nl/document/{id}/1):
//     HTTP 400 with an XML body containing "<error_code>" = gone (observed
//     message: "Document kan niet gedownload worden"). HTTP 200 = live.
//     Anything else (including a bare 404, which this endpoint does not use)
//     = unknown.
//   - Parlaeus / Gemeenteoplossingen: not yet calibrated. Always "unknown" --
//     do not guess a gone-signal without testing it against real documents
//     first, exactly as this file's own history warns against.
//
// Must run where Quickwit and the ops SQLite database are reachable (e.g.
// inside the running openbesluitvorming container).

import {
  getRevalidationCursor,
  listConfirmedGoneDocuments,
  recordRevalidationResult,
  setRevalidationCursor,
} from "../src/ops/store.ts";
import { currentProjectionVersion } from "../src/pipeline/versioning.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import type { QuickwitSearchDocument } from "../src/quickwit/project.ts";

const QUICKWIT_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const SLEEP_BETWEEN_REQUESTS_MS = 250;

const ORG_DOWN_MIN_SAMPLE = 10;
const ORG_DOWN_RATIO = 0.95;
const CONFIRM_THRESHOLD = 3;

type Status = "live" | "gone" | "unknown";

interface ParsedEntityId {
  entityId: string;
  supplier: string;
  sourceKey: string;
}

function parseEntityId(entityId: string): ParsedEntityId {
  const parts = entityId.split(":");
  if (parts.length < 5 || parts[0] !== "document") {
    throw new Error(`Not a document entity id: ${entityId}`);
  }
  return { entityId, supplier: parts[1], sourceKey: parts[3] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStatus(url: string): Promise<{ status: number | null; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "woozi-revalidate/1.0" },
    });
    const body = await response.text();
    return { status: response.status, body };
  } catch {
    return { status: null, body: "" }; // timeout, DNS failure, connection reset, ...
  } finally {
    clearTimeout(timer);
  }
}

async function classifyIbabs(url: string | undefined): Promise<Status> {
  if (!url) {
    return "unknown";
  }
  const { status } = await fetchStatus(url);
  if (status === 200) {
    return "live";
  }
  if (status === 403 || status === 404) {
    return "gone";
  }
  return "unknown";
}

async function classifyNotubiz(url: string | undefined): Promise<Status> {
  if (!url) {
    return "unknown";
  }
  const { status, body } = await fetchStatus(url);
  if (status === 200) {
    return "live";
  }
  if (status === 400 && body.includes("<error_code>")) {
    return "gone";
  }
  return "unknown";
}

async function classify(supplier: string, url: string | undefined): Promise<Status> {
  if (supplier === "ibabs") {
    return await classifyIbabs(url);
  }
  if (supplier === "notubiz") {
    return await classifyNotubiz(url);
  }
  return "unknown"; // parlaeus, gemeenteoplossingen: not yet calibrated
}

interface DocumentHit {
  entityId: string;
  sourceKey: string;
  url: string | undefined;
}

async function fetchBatch(
  quickwit: QuickwitClient,
  supplier: string,
  startOffset: number,
  limit: number,
): Promise<DocumentHit[]> {
  const response = await quickwit.searchRequest({
    query: `projection_version:"${currentProjectionVersion()}" AND entity_type:Document AND supplier:${supplier}`,
    max_hits: Math.min(limit, QUICKWIT_PAGE_SIZE),
    start_offset: startOffset,
  });

  return (response.hits as unknown as QuickwitSearchDocument[]).map((hit) => ({
    entityId: hit.entity_id,
    sourceKey: hit.source_key ?? parseEntityId(hit.entity_id).sourceKey,
    url: (hit.payload as { original_url?: string } | undefined)?.original_url,
  }));
}

async function report(supplier: string): Promise<void> {
  const confirmed = await listConfirmedGoneDocuments(supplier, CONFIRM_THRESHOLD);
  if (confirmed.length === 0) {
    console.log(
      `no confirmed-gone ${supplier} documents yet (threshold=${CONFIRM_THRESHOLD} consecutive gone-runs)`,
    );
    return;
  }
  console.log(
    `\n=== confirmed gone at source (${supplier}), review and delete manually if legitimate ===`,
  );
  for (const entry of confirmed) {
    console.log(
      `  entity_id=${entry.entity_id}  source_key=${entry.source_key}  streak=${entry.streak}  last_checked=${entry.last_checked_at}  url=${entry.url}`,
    );
  }
}

async function runSweep(supplier: string, limit: number): Promise<void> {
  const quickwit = new QuickwitClient();
  const startOffset = await getRevalidationCursor(supplier);
  const batch: DocumentHit[] = [];
  let offset = startOffset;
  while (batch.length < limit) {
    const page = await fetchBatch(quickwit, supplier, offset, Math.min(QUICKWIT_PAGE_SIZE, limit - batch.length));
    if (page.length === 0) {
      break;
    }
    batch.push(...page);
    offset += page.length;
    if (page.length < QUICKWIT_PAGE_SIZE) {
      break;
    }
  }

  if (batch.length === 0) {
    console.log(`no more ${supplier} documents after offset ${startOffset} -- wrapping cursor to 0`);
    await setRevalidationCursor(supplier, 0);
    return;
  }

  const bySourceKey = new Map<string, { live: DocumentHit[]; gone: DocumentHit[] }>();
  let unknownCount = 0;

  for (const hit of batch) {
    const status = await classify(supplier, hit.url);
    const bucket = bySourceKey.get(hit.sourceKey) ?? { live: [], gone: [] };
    if (status === "live") {
      bucket.live.push(hit);
    } else if (status === "gone") {
      bucket.gone.push(hit);
    } else {
      unknownCount += 1;
    }
    bySourceKey.set(hit.sourceKey, bucket);
    await sleep(SLEEP_BETWEEN_REQUESTS_MS);
  }

  let liveCount = 0;
  let goneCount = 0;
  const downSourceKeys: string[] = [];
  const toRecord: Array<{ hit: DocumentHit; status: "live" | "gone" }> = [];

  for (const [sourceKey, bucket] of bySourceKey) {
    const checked = bucket.live.length + bucket.gone.length;
    const goneRatio = checked > 0 ? bucket.gone.length / checked : 0;
    liveCount += bucket.live.length;
    if (checked >= ORG_DOWN_MIN_SAMPLE && goneRatio >= ORG_DOWN_RATIO) {
      downSourceKeys.push(sourceKey);
      continue; // outage, not deletions: don't record either direction
    }
    goneCount += bucket.gone.length;
    for (const hit of bucket.live) toRecord.push({ hit, status: "live" });
    for (const hit of bucket.gone) toRecord.push({ hit, status: "gone" });
  }

  console.log(
    `supplier=${supplier} checked=${batch.length} live=${liveCount} gone=${goneCount} unknown=${unknownCount}`,
  );
  for (const sourceKey of downSourceKeys) {
    const bucket = bySourceKey.get(sourceKey)!;
    console.log(
      `  source_key '${sourceKey}' looks fully unreachable (${bucket.gone.length}/${bucket.live.length + bucket.gone.length} gone) -- treating as an outage/API problem, NOT recording these as deletions`,
    );
  }

  for (const { hit, status } of toRecord) {
    await recordRevalidationResult(
      hit.entityId,
      supplier,
      hit.sourceKey,
      status,
      hit.url ?? null,
    );
  }

  await setRevalidationCursor(supplier, offset);
  await report(supplier);
}

function argValue(name: string): string | null {
  const index = Deno.args.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < Deno.args.length) {
    return Deno.args[index + 1];
  }
  return null;
}

async function main(): Promise<void> {
  const supplier = argValue("supplier");
  if (!supplier) {
    console.error(
      "Usage: revalidate_documents.ts --supplier <ibabs|notubiz> [--limit N] [--report-only]",
    );
    Deno.exit(1);
  }

  if (Deno.args.includes("--report-only")) {
    await report(supplier);
    return;
  }

  const limit = Number(argValue("limit") ?? "500");
  await runSweep(supplier, limit);
}

await main();
