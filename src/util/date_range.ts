/** Split a date range into chunks of at most `chunkMonths`, with no overlap and
 * no gaps.
 *
 * Suppliers answer a whole date range in one response, and both of ours fall
 * over when that response gets big enough. iBabs times out or OOMs the XML
 * parser on multi-year windows; Notubiz answers a one-year window for some
 * organisations with `404 {"message": "An uncaught error has occurred"}` while
 * the same organisation serves a quarter perfectly well (measured on Purmerend,
 * 2026-08-12). Neither failure looks like a size problem from the outside,
 * which is exactly why the chunking has to be the default rather than something
 * you reach for after a run fails.
 *
 * `chunkMonths <= 0` disables chunking and returns the range unchanged.
 */
export function splitDateRange(
  dateFrom: string,
  dateTo: string,
  chunkMonths: number,
): Array<[string, string]> {
  if (chunkMonths <= 0) {
    return [[dateFrom, dateTo]];
  }

  const chunks: Array<[string, string]> = [];
  const end = new Date(`${dateTo}T00:00:00Z`);
  let cursor = new Date(`${dateFrom}T00:00:00Z`);

  while (cursor <= end) {
    const nextCursor = new Date(cursor);
    nextCursor.setUTCMonth(nextCursor.getUTCMonth() + chunkMonths);

    const chunkEnd = nextCursor > end ? end : new Date(nextCursor.getTime() - 86_400_000);
    chunks.push([cursor.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);

    cursor = nextCursor;
  }

  return chunks;
}
