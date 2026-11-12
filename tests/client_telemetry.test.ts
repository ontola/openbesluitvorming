import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert";
import { dailySalt, hashClient } from "../web/client_telemetry.ts";

Deno.test("client id is a short hex hash, stable for one salt", async () => {
  const salt = new Uint8Array(32).fill(7);
  const first = await hashClient("203.0.113.9", salt);
  assertMatch(first, /^[0-9a-f]{16}$/);
  assertEquals(await hashClient("203.0.113.9", salt), first);
  assertNotEquals(await hashClient("203.0.113.10", salt), first);
});

Deno.test("client id changes with the salt", async () => {
  const a = await hashClient("2001:db8::1", new Uint8Array(32).fill(1));
  const b = await hashClient("2001:db8::1", new Uint8Array(32).fill(2));
  assertNotEquals(a, b);
});

Deno.test("the salt holds for a UTC day and is replaced the next", () => {
  const morning = dailySalt(new Date("2026-10-29T00:00:01Z"));
  const evening = dailySalt(new Date("2026-10-29T23:59:59Z"));
  const nextDay = dailySalt(new Date("2026-10-30T00:00:00Z"));
  assertEquals(evening.salt, morning.salt);
  assertEquals(nextDay.day, "2026-10-30");
  assertNotEquals(nextDay.salt, morning.salt);
});
