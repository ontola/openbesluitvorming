import { getNotubizSource } from "./sources/notubiz.ts";
import { NotubizMeetingExtractor } from "./notubiz/extractor.ts";
import { QuickwitClient } from "./quickwit/client.ts";

if (import.meta.main) {
  const args = [...Deno.args];
  const shouldIngestToQuickwit = args.includes("--quickwit");
  const positionalArgs = args.filter((arg) => arg !== "--quickwit");
  const [sourceKey, dateFrom, dateTo] = positionalArgs;

  if (!sourceKey || !dateFrom || !dateTo) {
    console.error("Usage: deno run -A src/main.ts [--quickwit] <sourceKey> <dateFrom> <dateTo>");
    Deno.exit(1);
  }

  const source = getNotubizSource(sourceKey);
  const extractor = new NotubizMeetingExtractor();
  const meetings = await extractor.extractForDateRange(source, dateFrom, dateTo);
  const events = await extractor.extractCommitEventsForDateRange(source, dateFrom, dateTo);

  if (shouldIngestToQuickwit) {
    const quickwit = new QuickwitClient();
    const configPath = new URL("../quickwit/index-config.json", import.meta.url);
    await quickwit.waitUntilReady();
    await quickwit.ensureIndex(configPath.pathname);
    await quickwit.ingestMeetingEvents(events);

    console.log(
      JSON.stringify(
        {
          source: source.key,
          supplier: source.supplier,
          date_from: dateFrom,
          date_to: dateTo,
          count: meetings.length,
          ingested_to_quickwit: true,
          quickwit_index_id: "woozi-events",
        },
        null,
        2,
      ),
    );
    Deno.exit(0);
  }

  console.log(
    JSON.stringify(
      {
        source: source.key,
        supplier: source.supplier,
        date_from: dateFrom,
        date_to: dateTo,
        count: meetings.length,
        meetings,
        events,
      },
      null,
      2,
    ),
  );
}
