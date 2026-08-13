import { assertEquals } from "jsr:@std/assert";
import { supplierDateTimeToUtc } from "../src/util/local_time.ts";

Deno.test("supplierDateTimeToUtc reads a bare reading as Dutch wall clock", () => {
  // The case in #203: a 19:30 council meeting was stamped 19:30 UTC, so every
  // consumer reading it as an instant saw it two hours late in summer.
  assertEquals(supplierDateTimeToUtc("2026-08-19T19:30:00"), "2026-08-19T17:30:00Z");
  assertEquals(supplierDateTimeToUtc("2026-08-19 19:30:00"), "2026-08-19T17:30:00Z");
  assertEquals(supplierDateTimeToUtc("2026-08-19T19:30"), "2026-08-19T17:30:00Z");
});

Deno.test("supplierDateTimeToUtc follows the seasonal offset", () => {
  // CET in winter, CEST in summer. The same wall clock is a different instant.
  assertEquals(supplierDateTimeToUtc("2026-01-14T19:30:00"), "2026-01-14T18:30:00Z");
  assertEquals(supplierDateTimeToUtc("2026-07-14T19:30:00"), "2026-07-14T17:30:00Z");
});

Deno.test("supplierDateTimeToUtc resolves readings around a DST switch", () => {
  // 2026-03-29 02:00 local is when CET becomes CEST, and 2026-10-25 03:00 is
  // when it goes back. A single offset lookup, taken as if the reading were
  // already UTC, lands on the wrong side of both.
  assertEquals(supplierDateTimeToUtc("2026-03-29T01:30:00"), "2026-03-29T00:30:00Z");
  assertEquals(supplierDateTimeToUtc("2026-03-29T03:30:00"), "2026-03-29T01:30:00Z");
  assertEquals(supplierDateTimeToUtc("2026-10-25T04:30:00"), "2026-10-25T03:30:00Z");
});

Deno.test("supplierDateTimeToUtc trusts a reading that carries its own offset", () => {
  // Notubiz sends this shape for some organisations. Appending `Z` to it used
  // to produce `2025-01-14T19:30:00+01:00Z`, which is not a date at all.
  assertEquals(supplierDateTimeToUtc("2025-01-14T19:30:00+01:00"), "2025-01-14T18:30:00Z");
  assertEquals(supplierDateTimeToUtc("2025-07-14T19:30:00+02:00"), "2025-07-14T17:30:00Z");
  assertEquals(supplierDateTimeToUtc("2025-01-14T18:30:00Z"), "2025-01-14T18:30:00Z");
});

Deno.test("supplierDateTimeToUtc leaves a date without a moment at midnight UTC", () => {
  // A publication day and GO's `T00:00:00` filler are dates, not moments.
  // Shifting them back two hours would move them to the previous day for any
  // consumer that reads only the date part.
  assertEquals(supplierDateTimeToUtc("2026-08-19"), "2026-08-19T00:00:00Z");
  assertEquals(supplierDateTimeToUtc("2026-08-19T00:00:00"), "2026-08-19T00:00:00Z");
});

Deno.test("supplierDateTimeToUtc gives up rather than invent a value", () => {
  assertEquals(supplierDateTimeToUtc(undefined), undefined);
  assertEquals(supplierDateTimeToUtc(""), undefined);
  assertEquals(supplierDateTimeToUtc("   "), undefined);
  assertEquals(supplierDateTimeToUtc("geen datum"), undefined);
  assertEquals(supplierDateTimeToUtc("0000-00-00T00:00:00"), undefined);
});
