import { buildEntityCommitEvent } from "./events/entity_commit.ts";
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
  const extraction = await extractor.extractForDateRange(source, dateFrom, dateTo);
  const events = await Promise.all(
    [...extraction.meetings, ...extraction.documents].map((entity) =>
      buildEntityCommitEvent(entity),
    ),
  );

  if (shouldIngestToQuickwit) {
    const quickwit = new QuickwitClient();
    const configPath = new URL("../quickwit/index-config.json", import.meta.url);
    await quickwit.waitUntilReady();
    await quickwit.ensureIndex(configPath.pathname);
    await quickwit.ingestEvents(events);

    console.log(
      JSON.stringify(
        {
          source: source.key,
          supplier: source.supplier,
          date_from: dateFrom,
          date_to: dateTo,
          meeting_count: extraction.meetings.length,
          document_count: extraction.documents.length,
          count: extraction.meetings.length + extraction.documents.length,
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
        meeting_count: extraction.meetings.length,
        document_count: extraction.documents.length,
        count: extraction.meetings.length + extraction.documents.length,
        meetings: extraction.meetings,
        documents: extraction.documents,
        events,
      },
      null,
      2,
    ),
  );
}
