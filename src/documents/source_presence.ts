/**
 * Ask a supplier whether it still serves a document, without keeping the
 * file.
 *
 * Only responses calibrated against known-live and known-removed documents
 * count (2026-07-23, see scripts/revalidate_documents.ts for the history):
 *   - iBabs (PublicDownloadURL): 200 live, 403 or 404 gone.
 *   - Notubiz (api.notubiz.nl/document/{id}/{version}): 200 live, 400 with an
 *     XML `<error_code>` body gone ("Document kan niet gedownload worden").
 * Anything else, and every other supplier, is "unknown": not a removal.
 */

import { ibabsDownloadRateLimiter } from "../ibabs/rate_limit.ts";

export type SourcePresence = "live" | "gone" | "unknown";

const PROBE_TIMEOUT_MS = 30_000;

export function canProbeSupplier(supplier: string): boolean {
  return supplier === "ibabs" || supplier === "notubiz";
}

export async function probeDocumentAtSource(
  supplier: string,
  url: string | undefined,
): Promise<SourcePresence> {
  if (!url || !canProbeSupplier(supplier)) {
    return "unknown";
  }
  if (supplier === "ibabs") {
    // Same address, same budget as a download. No recordThrottle on 403:
    // here a 403 is the answer we are asking for, not a sign to back off.
    await ibabsDownloadRateLimiter().acquire();
  }
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "*/*", "user-agent": "woozi-revalidate/1.0" },
    });
  } catch {
    return "unknown";
  }
  try {
    if (response.status === 200) {
      return "live";
    }
    if (supplier === "ibabs") {
      return response.status === 403 || response.status === 404 ? "gone" : "unknown";
    }
    if (response.status === 400) {
      const body = await response.text().catch(() => "");
      return body.includes("<error_code>") ? "gone" : "unknown";
    }
    return "unknown";
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
