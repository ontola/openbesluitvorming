import { splitDateRange } from "../src/util/date_range.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("a year splits into quarters with no gap and no overlap", () => {
  // The property that matters: a meeting must land in exactly one chunk. A gap
  // loses it silently, an overlap imports it twice.
  const chunks = splitDateRange("2025-07-01", "2026-06-30", 3);
  assertEquals(chunks.length, 4, "four quarters");
  assertEquals(chunks[0][0], "2025-07-01", "starts at the range start");
  assertEquals(chunks[chunks.length - 1][1], "2026-06-30", "ends at the range end");

  for (let i = 1; i < chunks.length; i += 1) {
    const previousEnd = new Date(`${chunks[i - 1][1]}T00:00:00Z`).getTime();
    const nextStart = new Date(`${chunks[i][0]}T00:00:00Z`).getTime();
    assertEquals(
      nextStart - previousEnd,
      86_400_000,
      `chunk ${i} must start the day after chunk ${i - 1} ends`,
    );
  }
});

Deno.test("a range shorter than one chunk stays whole", () => {
  assertEquals(
    splitDateRange("2026-03-01", "2026-03-31", 3),
    [["2026-03-01", "2026-03-31"]],
    "no needless splitting",
  );
});

Deno.test("chunking can be switched off", () => {
  assertEquals(
    splitDateRange("2020-01-01", "2026-01-01", 0),
    [["2020-01-01", "2026-01-01"]],
    "zero means one chunk",
  );
});

Deno.test("a single day is one chunk", () => {
  const chunks = splitDateRange("2026-04-01", "2026-04-01", 3);
  assertEquals(chunks, [["2026-04-01", "2026-04-01"]], "start and end on the same day");
});
