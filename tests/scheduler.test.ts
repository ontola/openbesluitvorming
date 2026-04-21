import { __test__ } from "../src/scheduler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("nextScheduledTime targets 04:00 Europe/Amsterdam (CEST offset +2)", () => {
  // 2026-07-15 10:00 UTC is 12:00 CEST. Next 04:00 Amsterdam is 2026-07-16 02:00 UTC.
  const now = new Date("2026-07-15T10:00:00Z");
  const next = __test__.nextScheduledTime(now);
  assert(next.toISOString() === "2026-07-16T02:00:00.000Z", `got ${next.toISOString()}`);
});

Deno.test("nextScheduledTime targets 04:00 Europe/Amsterdam (CET offset +1)", () => {
  // 2026-01-15 10:00 UTC is 11:00 CET. Next 04:00 Amsterdam is 2026-01-16 03:00 UTC.
  const now = new Date("2026-01-15T10:00:00Z");
  const next = __test__.nextScheduledTime(now);
  assert(next.toISOString() === "2026-01-16T03:00:00.000Z", `got ${next.toISOString()}`);
});

Deno.test("nextScheduledTime picks today if 04:00 Amsterdam is still ahead", () => {
  // 2026-07-15 00:00 UTC is 02:00 CEST. Next 04:00 Amsterdam is same day 02:00 UTC.
  const now = new Date("2026-07-15T00:00:00Z");
  const next = __test__.nextScheduledTime(now);
  assert(next.toISOString() === "2026-07-15T02:00:00.000Z", `got ${next.toISOString()}`);
});

Deno.test("isoDate returns YYYY-MM-DD in UTC", () => {
  assert(__test__.isoDate(new Date("2026-04-21T23:59:59Z")) === "2026-04-21", "UTC end-of-day");
  assert(__test__.isoDate(new Date("2026-04-22T00:00:00Z")) === "2026-04-22", "UTC midnight");
});
