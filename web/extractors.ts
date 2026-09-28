/** Live stats of the remote extraction workers, as the admin dashboard and
 * /api/ops/health show them. Each worker answers `GET /stats`
 * (services/extraction/main.py): load, free disk, request counters. */

export interface ExtractorStatus {
  url: string;
  status: "ok" | "unreachable";
  [key: string]: unknown;
}

export function configuredExtractorUrls(): string[] {
  const raw = Deno.env.get("WOOZI_EXTRACTION_SERVICE_URL")?.trim() ?? "";
  return raw
    ? raw
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)
    : [];
}

export async function fetchExtractorStats(
  urls: string[] = configuredExtractorUrls(),
): Promise<ExtractorStatus[]> {
  return await Promise.all(
    urls.map(async (workerUrl) => {
      try {
        // 3s was too tight under load — extractors at CPU load ~2 can
        // legitimately take longer to respond, causing the dashboard
        // to flap some nodes to "unreachable" even though they're
        // actively processing.
        const response = await fetch(`${workerUrl}/stats`, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const stats = await response.json();
        return { url: workerUrl, status: "ok" as const, ...stats };
      } catch {
        return { url: workerUrl, status: "unreachable" as const };
      }
    }),
  );
}
