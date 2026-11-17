import { toNdjson, toNdjsonLine } from "../src/exports/ndjson.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\n  expected: ${expectedJson}\n  actual:   ${actualJson}`);
  }
}

Deno.test("NDJSON lines escape characters that line splitters treat as breaks (#414)", () => {
  const record = { name: "Raadsbrief\u2028over\u2029iets\u0085anders", text: "a\r\nb" };
  const line = toNdjsonLine(record);
  assertEquals(/[\u0085\u2028\u2029\r\n]/.test(line), false, "no raw line break in a line");
  assertEquals(JSON.parse(line), record, "the escaped line parses to the same value");

  const body = toNdjson([record, { name: "tweede" }]);
  assertEquals(body.split("\n").length, 3, "two lines plus the trailing newline");
  assertEquals(toNdjson([]), "", "an empty page is an empty body");
});
