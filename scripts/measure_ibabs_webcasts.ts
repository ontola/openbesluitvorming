// Measures what share of iBabs meetings carry a webcast, and therefore how
// much video, transcript and speaker timeline is reachable via Company Webcast.
//
// This is the number the video import plan lists as its open question. It cannot
// be answered from the search index — that stores rows, not meetings — and it
// needs the `Webcast.Code` field that only `GetMeetingsByDateRange` returns.
//
// Must run from the IP-whitelisted production host, and only when the backfill
// is quiet: iBabs answers a burst with HTTP 403 ("The request is blocked") and
// the fleet-wide breaker will refuse to call at all while it is open.
//
// Usage (on woozi-1, inside a container that has Deno):
//   deno run -A scripts/measure_ibabs_webcasts.ts --from 2026-01-01 --to 2026-06-30
//   deno run -A scripts/measure_ibabs_webcasts.ts --sites amstelveen,utrecht --out /tmp/webcasts.csv

import { IbabsClient } from "../src/ibabs/client.ts";
import { listSources } from "../src/sources/index.ts";
import type { IbabsSourceDefinition } from "../src/types.ts";

function arg(name: string): string | undefined {
  const index = Deno.args.indexOf(`--${name}`);
  return index === -1 ? undefined : Deno.args[index + 1];
}

interface SiteResult {
  key: string;
  sitename: string;
  meetings: number;
  withWebcast: number;
  /** Distinct Company Webcast client codes seen, from the code's own prefix.
   * Usually the sitename, but not always — that mismatch is worth knowing
   * before anyone assumes the two are interchangeable. */
  clients: string[];
  error?: string;
}

async function measureSite(
  client: IbabsClient,
  source: IbabsSourceDefinition,
  dateFrom: string,
  dateTo: string,
): Promise<SiteResult> {
  const result: SiteResult = {
    key: source.key,
    sitename: source.ibabsSitename,
    meetings: 0,
    withWebcast: 0,
    clients: [],
  };

  try {
    const meetings = await client.listMeetingsByDateRange(source, dateFrom, dateTo);
    const clients = new Set<string>();
    for (const meeting of meetings) {
      result.meetings += 1;
      const code = meeting.WebcastCode?.trim();
      if (!code) {
        continue;
      }
      result.withWebcast += 1;
      const [clientCode] = code.split("/");
      if (clientCode) {
        clients.add(clientCode);
      }
    }
    result.clients = [...clients].sort();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

if (import.meta.main) {
  const dateFrom = arg("from") ?? "2026-01-01";
  const dateTo = arg("to") ?? "2026-06-30";
  const only = arg("sites")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const sources = listSources()
    .filter((source): source is IbabsSourceDefinition => source.supplier === "ibabs")
    .filter((source) => !only || only.includes(source.key) || only.includes(source.ibabsSitename));

  if (sources.length === 0) {
    console.error("No matching iBabs sources.");
    Deno.exit(1);
  }

  console.log(`[webcasts] ${sources.length} sources, ${dateFrom} .. ${dateTo}`);
  const client = new IbabsClient();
  const rows: SiteResult[] = [];

  // Deliberately sequential. The point of this script is a clean measurement,
  // and a parallel sweep is exactly what makes iBabs start refusing calls
  // halfway through and turn the result into noise.
  for (const source of sources) {
    const row = await measureSite(client, source, dateFrom, dateTo);
    rows.push(row);
    const share = row.meetings > 0 ? `${Math.round((row.withWebcast / row.meetings) * 100)}%` : "-";
    console.log(
      `${row.sitename.padEnd(24)} ${String(row.withWebcast).padStart(4)}/${String(
        row.meetings,
      ).padEnd(4)} ${share.padStart(4)}` +
        (row.clients.length > 0 ? `  clients=${row.clients.join(",")}` : "") +
        (row.error ? `  ERROR ${row.error}` : ""),
    );
  }

  const ok = rows.filter((row) => !row.error);
  const failed = rows.filter((row) => row.error);
  const meetings = ok.reduce((total, row) => total + row.meetings, 0);
  const withWebcast = ok.reduce((total, row) => total + row.withWebcast, 0);
  const sitesWithAny = ok.filter((row) => row.withWebcast > 0).length;
  const mismatched = ok.filter((row) =>
    row.clients.some((clientCode) => clientCode !== row.sitename),
  );

  console.log("\n=== samenvatting ===");
  console.log(
    `bronnen gemeten      : ${ok.length}${failed.length ? ` (${failed.length} mislukt)` : ""}`,
  );
  console.log(`bronnen met webcasts : ${sitesWithAny}`);
  console.log(`vergaderingen        : ${meetings}`);
  console.log(
    `met webcast          : ${withWebcast}` +
      (meetings > 0 ? ` (${Math.round((withWebcast / meetings) * 100)}%)` : ""),
  );
  if (mismatched.length > 0) {
    console.log(
      `\nwebcast-klantcode wijkt af van de sitename bij ${mismatched.length} bron(nen): ` +
        mismatched.map((row) => `${row.sitename}->${row.clients.join("/")}`).join(", "),
    );
  }
  if (failed.length > 0) {
    console.log(`\nmislukt: ${failed.map((row) => `${row.sitename} (${row.error})`).join("; ")}`);
  }

  const outPath = arg("out");
  if (outPath) {
    const csv = [
      "sitename,source_key,meetings,with_webcast,share,clients,error",
      ...rows.map((row) =>
        [
          row.sitename,
          row.key,
          row.meetings,
          row.withWebcast,
          row.meetings > 0 ? (row.withWebcast / row.meetings).toFixed(3) : "",
          row.clients.join(" "),
          row.error ? JSON.stringify(row.error) : "",
        ].join(","),
      ),
    ].join("\n");
    await Deno.writeTextFile(outPath, csv);
    console.log(`\n[webcasts] wrote ${outPath}`);
  }
}
