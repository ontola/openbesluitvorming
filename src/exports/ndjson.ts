/** One NDJSON line for a record. JSON.stringify leaves U+0085, U+2028 and
 * U+2029 raw: valid JSON, but line splitters such as Python's
 * `str.splitlines()` break a line on them, mid-string (#414). Escaping them
 * yields the same JSON value and leaves `\n` as the only line break. */
export function toNdjsonLine(record: unknown): string {
  return JSON.stringify(record).replace(
    /[\u0085\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function toNdjson(records: unknown[]): string {
  return records.length > 0 ? records.map(toNdjsonLine).join("\n") + "\n" : "";
}
