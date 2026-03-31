import { getNotubizSource } from "./sources/notubiz.ts";
import { NotubizMeetingExtractor } from "./notubiz/extractor.ts";

if (import.meta.main) {
  const [sourceKey, dateFrom, dateTo] = Deno.args;

  if (!sourceKey || !dateFrom || !dateTo) {
    console.error("Usage: deno run -A src/main.ts <sourceKey> <dateFrom> <dateTo>");
    Deno.exit(1);
  }

  const source = getNotubizSource(sourceKey);
  const extractor = new NotubizMeetingExtractor();
  const meetings = await extractor.extractForDateRange(source, dateFrom, dateTo);
  const events = await extractor.extractCommitEventsForDateRange(source, dateFrom, dateTo);

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
