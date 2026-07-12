// Builds a shareable CSV report from BSN scan findings (scan_bsn_s3.ts output)
// by enriching each document with metadata from the Quickwit index.
//
// Usage:
//   QUICKWIT_URL=https://openbesluitvorming.nl QUICKWIT_INDEX_ID=woozi-events-prod \
//     deno run -A scripts/bsn_report.ts --findings bsn-findings.ndjson --out bsn-report.csv
//
// Optional: --confidence high  (only high-confidence findings)
//
// The report contains masked digits only — safe to forward for review.

import { QuickwitClient } from "../src/quickwit/client.ts";

interface Finding {
  key: string;
  entityId: string | null;
  confidence: string;
  matches: Array<{ masked: string; nearKeyword: boolean; context: string }>;
}

interface ReportRow {
  organisatie: string;
  leverancier: string;
  document: string;
  bestandsnaam: string;
  datum: string;
  confidence: string;
  aantal_matches: number;
  voorbeeld_context: string;
  original_url: string;
  viewer_url: string;
  entity_id: string;
}

function argValue(name: string, fallback: string): string {
  const index = Deno.args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < Deno.args.length ? Deno.args[index + 1] : fallback;
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function lookupDocument(
  quickwit: QuickwitClient,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const response = await quickwit.searchRequest({
    query: `entity_id:"${entityId.replaceAll('"', '\\"')}" AND entity_type:Document`,
    max_hits: 10,
  });
  let newest: Record<string, unknown> | null = null;
  for (const hit of response.hits) {
    const time = typeof hit.time === "string" ? hit.time : "";
    const newestTime = typeof newest?.time === "string" ? newest.time : "";
    if (!newest || time > newestTime) {
      newest = hit;
    }
  }
  return newest;
}

async function main(): Promise<void> {
  const findingsPath = argValue("findings", "bsn-findings.ndjson");
  const outPath = argValue("out", "bsn-report.csv");
  const confidenceFilter = argValue("confidence", "");

  const byEntity = new Map<string, Finding>();
  for (const line of (await Deno.readTextFile(findingsPath)).split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const finding = JSON.parse(line) as Finding;
    if (!finding.entityId) {
      console.warn(`[warning] finding without entityId skipped: ${finding.key}`);
      continue;
    }
    if (confidenceFilter && finding.confidence !== confidenceFilter) {
      continue;
    }
    // Multiple markdown versions per document: keep the one with most matches.
    const existing = byEntity.get(finding.entityId);
    if (!existing || finding.matches.length > existing.matches.length) {
      byEntity.set(finding.entityId, finding);
    }
  }

  console.log(`enriching ${byEntity.size} unique documents from ${findingsPath}`);
  const quickwit = new QuickwitClient();
  const rows: ReportRow[] = [];
  const entries = [...byEntity.values()];
  const concurrency = 8;

  for (let offset = 0; offset < entries.length; offset += concurrency) {
    await Promise.all(
      entries.slice(offset, offset + concurrency).map(async (finding) => {
        const entityId = finding.entityId as string;
        let hit: Record<string, unknown> | null = null;
        try {
          hit = await lookupDocument(quickwit, entityId);
        } catch (error) {
          console.warn(`[warning] lookup failed ${entityId}: ${String(error)}`);
        }
        const payload = (hit?.payload ?? {}) as Record<string, unknown>;
        rows.push({
          organisatie: String(hit?.source_key ?? entityId.split(":")[3] ?? ""),
          leverancier: String(hit?.supplier ?? entityId.split(":")[1] ?? ""),
          document: String(hit?.name ?? ""),
          bestandsnaam: String(hit?.file_name ?? ""),
          datum: String(hit?.start_date ?? "").slice(0, 10),
          confidence: finding.confidence,
          aantal_matches: finding.matches.length,
          voorbeeld_context: finding.matches[0]?.context ?? "",
          original_url: String(payload.original_url ?? ""),
          viewer_url: `https://openbesluitvorming.nl/?view=${encodeURIComponent(entityId)}`,
          entity_id: entityId,
        });
      }),
    );
    console.log(`[progress] ${Math.min(offset + concurrency, entries.length)}/${entries.length}`);
  }

  rows.sort((left, right) =>
    left.organisatie === right.organisatie
      ? right.aantal_matches - left.aantal_matches
      : left.organisatie.localeCompare(right.organisatie)
  );

  const header = [
    "organisatie",
    "leverancier",
    "document",
    "bestandsnaam",
    "datum",
    "confidence",
    "aantal_matches",
    "voorbeeld_context",
    "original_url",
    "viewer_url",
    "entity_id",
  ];
  const lines = [
    header.join(","),
    ...rows.map((row) => header.map((column) => csvField(row[column as keyof ReportRow])).join(",")),
  ];
  await Deno.writeTextFile(outPath, lines.join("\n") + "\n");
  console.log(`[done] ${rows.length} documents → ${outPath}`);
}

await main();
