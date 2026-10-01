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

/** Shared by the import and the revalidation sweep. The sweep used 10 s on
 * its own; a slow supplier then answers "unknown", which removes nothing. */
const PROBE_TIMEOUT_MS = 30_000;

export function canProbeSupplier(supplier: string): boolean {
  return supplier === "ibabs" || supplier === "notubiz";
}

/** What the supplier answered, kept as evidence beside the verdict. */
export interface SourceProbe {
  presence: SourcePresence;
  url?: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** Notubiz's `<error_code>` when its 400 carried one. */
  error_code?: string;
}

export async function probeDocumentAtSource(
  supplier: string,
  url: string | undefined,
): Promise<SourceProbe> {
  if (!url || !canProbeSupplier(supplier)) {
    return { presence: "unknown", url, status: null };
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
    return { presence: "unknown", url, status: null };
  }
  const status = response.status;
  try {
    if (status === 200) {
      return { presence: "live", url, status };
    }
    if (supplier === "ibabs") {
      return { presence: status === 403 || status === 404 ? "gone" : "unknown", url, status };
    }
    if (status === 400) {
      const body = await response.text().catch(() => "");
      const errorCode = /<error_code>([^<]*)<\/error_code>/.exec(body)?.[1]?.trim();
      return body.includes("<error_code>")
        ? { presence: "gone", url, status, ...(errorCode ? { error_code: errorCode } : {}) }
        : { presence: "unknown", url, status };
    }
    return { presence: "unknown", url, status };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
