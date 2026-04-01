import { runIngest } from "./ingest.ts";

if (import.meta.main) {
  const args = [...Deno.args];
  const shouldIngestToQuickwit = args.includes("--quickwit");
  const positionalArgs = args.filter((arg) => arg !== "--quickwit");
  const [sourceKey, dateFrom, dateTo] = positionalArgs;

  if (!sourceKey || !dateFrom || !dateTo) {
    console.error("Usage: deno run -A src/main.ts [--quickwit] <sourceKey> <dateFrom> <dateTo>");
    Deno.exit(1);
  }

  try {
    const result = await runIngest(sourceKey, dateFrom, dateTo, {
      ingestToQuickwit: shouldIngestToQuickwit,
      trigger: "user",
    });

    console.log(
      JSON.stringify(
        {
          source: result.run.source_key,
          supplier: result.run.supplier,
          date_from: result.run.date_from,
          date_to: result.run.date_to,
          meeting_count: result.run.meeting_count,
          document_count: result.run.document_count,
          count: result.run.meeting_count + result.run.document_count,
          cache_hits: result.run.cache_hits,
          downloaded_count: result.run.downloaded_count,
          issue_count: result.run.issue_count,
          status: result.run.status,
          run_id: result.run.id,
          ingested_to_quickwit: shouldIngestToQuickwit,
          quickwit_index_id: result.quickwit_index_id,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingest failed";
    console.error(message);
    Deno.exit(1);
  }
}
