import { __test__ } from "../src/scheduler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("nextScheduledTime targets 02:00 Europe/Amsterdam (CEST offset +2)", () => {
  // 2026-07-15 10:00 UTC is 12:00 CEST. Next 02:00 Amsterdam is 2026-07-16 00:00 UTC.
  const now = new Date("2026-07-15T10:00:00Z");
  const next = __test__.nextScheduledTime(now);
  assert(next.toISOString() === "2026-07-16T00:00:00.000Z", `got ${next.toISOString()}`);
});

Deno.test("nextScheduledTime targets 02:00 Europe/Amsterdam (CET offset +1)", () => {
  // 2026-01-15 10:00 UTC is 11:00 CET. Next 02:00 Amsterdam is 2026-01-16 01:00 UTC.
  const now = new Date("2026-01-15T10:00:00Z");
  const next = __test__.nextScheduledTime(now);
  assert(next.toISOString() === "2026-01-16T01:00:00.000Z", `got ${next.toISOString()}`);
});

Deno.test("nextScheduledTime picks today if 02:00 Amsterdam is still ahead", () => {
  // 2026-07-14 23:30 UTC is 01:30 CEST on the 15th. Next 02:00 Amsterdam is 2026-07-15 00:00 UTC.
  const now = new Date("2026-07-14T23:30:00Z");
  const next = __test__.nextScheduledTime(now);
  assert(next.toISOString() === "2026-07-15T00:00:00.000Z", `got ${next.toISOString()}`);
});

Deno.test("isoDate returns YYYY-MM-DD in UTC", () => {
  assert(__test__.isoDate(new Date("2026-04-21T23:59:59Z")) === "2026-04-21", "UTC end-of-day");
  assert(__test__.isoDate(new Date("2026-04-22T00:00:00Z")) === "2026-04-22", "UTC midnight");
});

Deno.test("a weeknight enqueues only the nightly window", () => {
  // Tuesday 2026-09-29, 02:00 CEST.
  const windows = __test__.scheduledWindows(new Date("2026-09-29T00:00:00Z"));
  assert(windows.length === 1, `got ${JSON.stringify(windows)}`);
  assert(windows[0].dateFrom === "2026-09-22" && windows[0].dateTo === "2026-10-06", "±7 days");
});

Deno.test("Saturday night adds the sweep, adjacent to the nightly window", () => {
  // Saturday 2026-10-03, 02:00 CEST. Documents attached weeks after a
  // meeting fall outside the nightly window; the sweep picks them up.
  const windows = __test__.scheduledWindows(new Date("2026-10-03T00:00:00Z"));
  assert(windows.length === 2, `got ${JSON.stringify(windows)}`);
  assert(windows[0].dateFrom === "2026-09-26", "nightly window starts 7 days back");
  assert(
    windows[1].dateFrom === "2026-07-05" && windows[1].dateTo === "2026-09-25",
    `sweep covers 90..8 days back, got ${JSON.stringify(windows[1])}`,
  );
});
