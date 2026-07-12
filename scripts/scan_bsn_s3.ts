// Scans extracted-markdown objects in S3 for BSN (burgerservicenummer) hits.
//
// Usage:
//   deno run -A scripts/scan_bsn_s3.ts \
//     [--prefix documents/] [--out bsn-findings.ndjson] [--state bsn-scan-state.json] \
//     [--concurrency 24] [--limit 1000]
//
// The scan is resumable: progress (the last fully processed listing page) is
// persisted to the state file after every page, and findings are appended to
// the NDJSON output. Findings contain only masked digits, never a raw BSN.

import { scanForBsn } from "../src/documents/bsn.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

interface ScanState {
  startAfter?: string;
  listed: number;
  scanned: number;
  findings: number;
}

interface Finding {
  key: string;
  entityId: string | null;
  documentPrefix: string | null;
  confidence: string;
  matches: unknown[];
  scannedAt: string;
}

function argValue(name: string, fallback: string): string {
  const index = Deno.args.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < Deno.args.length) {
    return Deno.args[index + 1];
  }
  return fallback;
}

// Key layout (src/documents/process.ts objectKey):
//   documents/{supplier}/{orgType}/{source}/{canonicalId}/{version}/{fileName}[.{derivation}.md]
function parseKey(key: string): { entityId: string | null; documentPrefix: string | null } {
  const parts = key.split("/");
  if (parts.length !== 7 || parts[0] !== "documents") {
    return { entityId: null, documentPrefix: null };
  }
  const [, supplier, orgType, source, canonicalId] = parts;
  const entityId = canonicalId.includes(":")
    ? canonicalId
    : `document:${supplier}:${orgType}:${source}:${canonicalId}`;
  return {
    entityId,
    documentPrefix: `documents/${supplier}/${orgType}/${source}/${canonicalId}/`,
  };
}

async function loadState(path: string): Promise<ScanState> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as ScanState;
  } catch {
    return { listed: 0, scanned: 0, findings: 0 };
  }
}

async function main(): Promise<void> {
  const prefix = argValue("prefix", "documents/");
  const outPath = argValue("out", "bsn-findings.ndjson");
  const statePath = argValue("state", "bsn-scan-state.json");
  const concurrency = Number(argValue("concurrency", "24"));
  const limit = Number(argValue("limit", "0"));

  const storage = await ObjectStorageClient.fromEnvironment();
  const state = await loadState(statePath);
  if (state.startAfter) {
    console.log(`[resume] continuing after ${state.startAfter} (${state.scanned} scanned)`);
  }

  const startedAt = Date.now();
  let stop = false;

  while (!stop) {
    const { keys, isTruncated } = await storage.listObjects({
      prefix,
      startAfter: state.startAfter,
      maxKeys: 1000,
    });
    if (keys.length === 0) {
      break;
    }
    state.listed += keys.length;

    const markdownKeys = keys.filter((key) => key.endsWith(".md"));
    const pageFindings: Finding[] = [];

    for (let offset = 0; offset < markdownKeys.length; offset += concurrency) {
      const batch = markdownKeys.slice(offset, offset + concurrency);
      await Promise.all(
        batch.map(async (key) => {
          let text: string;
          try {
            text = await storage.getObjectText(key);
          } catch (error) {
            console.warn(`[warning] read failed ${key}: ${String(error)}`);
            return;
          }
          state.scanned += 1;
          const result = scanForBsn(text);
          if (!result.found) {
            return;
          }
          const parsed = parseKey(key);
          pageFindings.push({
            key,
            entityId: parsed.entityId,
            documentPrefix: parsed.documentPrefix,
            confidence: result.confidence,
            matches: result.matches,
            scannedAt: new Date().toISOString(),
          });
        }),
      );
    }

    if (pageFindings.length > 0) {
      state.findings += pageFindings.length;
      const lines = pageFindings.map((finding) => JSON.stringify(finding)).join("\n") + "\n";
      await Deno.writeTextFile(outPath, lines, { append: true });
      for (const finding of pageFindings) {
        console.log(`[hit] ${finding.confidence} ${finding.key}`);
      }
    }

    state.startAfter = keys[keys.length - 1];
    await Deno.writeTextFile(statePath, JSON.stringify(state, null, 2));

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = state.scanned / Math.max(1, elapsed);
    console.log(
      `[progress] listed=${state.listed} scanned=${state.scanned} hits=${state.findings} ` +
        `rate=${rate.toFixed(1)}/s`,
    );

    if (!isTruncated) {
      break;
    }
    if (limit > 0 && state.scanned >= limit) {
      console.log(`[stop] reached --limit ${limit}`);
      stop = true;
    }
  }

  console.log(
    `[done] scanned=${state.scanned} findings=${state.findings} output=${outPath}`,
  );
}

await main();
