import { assertEquals } from "jsr:@std/assert";
import { RATE_LIMIT_PAGE_UNIT, RateLimiter, requestCost } from "../web/rate_limit.ts";

function searchUrl(params: string): URL {
  return new URL(`https://openbesluitvorming.nl/api/search?${params}`);
}

/** Controllable clock so refill behaviour is deterministic. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advanceMs(ms: number) {
      current += ms;
    },
  };
}

Deno.test("a search costs one unit per page, so ordinary paging is cheap", () => {
  assertEquals(requestCost(searchUrl("q=fietspad")), 1, "default page size costs one unit");
  assertEquals(requestCost(searchUrl(`q=x&limit=${RATE_LIMIT_PAGE_UNIT}`)), 1, "UI page size");
  assertEquals(requestCost(searchUrl("q=x&limit=100")), 5, "the 100-result cap costs 5 units");
});

Deno.test("non-search endpoints and unusable limits cost a single unit", () => {
  assertEquals(requestCost(new URL("https://openbesluitvorming.nl/api/stats")), 1);
  assertEquals(requestCost(searchUrl("q=x&limit=abc")), 1, "garbage limit is not free-for-all");
  assertEquals(requestCost(searchUrl("q=x&limit=-5")), 1, "negative limit cannot refund tokens");
});

Deno.test("requests are allowed until the budget is spent, then rejected", () => {
  const limiter = new RateLimiter(60, fakeClock().now);
  for (let index = 0; index < 60; index += 1) {
    assertEquals(limiter.consume("1.2.3.4", 1).allowed, true, `request ${index} should pass`);
  }

  const blocked = limiter.consume("1.2.3.4", 1);
  assertEquals(blocked.allowed, false, "the 61st request in the same minute is rejected");
  assertEquals(blocked.remaining, 0);
  assertEquals(blocked.limit, 60);
});

Deno.test("clients are budgeted independently", () => {
  const limiter = new RateLimiter(10, fakeClock().now);
  for (let index = 0; index < 10; index += 1) {
    limiter.consume("noisy", 1);
  }

  assertEquals(limiter.consume("noisy", 1).allowed, false, "noisy client is exhausted");
  assertEquals(limiter.consume("quiet", 1).allowed, true, "a different IP is unaffected");
});

Deno.test("heavy scraping drains the budget faster than UI paging", () => {
  const clock = fakeClock();
  const heavy = new RateLimiter(60, clock.now);
  let heavyAllowed = 0;
  while (heavy.consume("scraper", requestCost(searchUrl("q=x&limit=100"))).allowed) {
    heavyAllowed += 1;
  }

  const light = new RateLimiter(60, fakeClock().now);
  let lightAllowed = 0;
  while (light.consume("browser", requestCost(searchUrl("q=x&limit=24"))).allowed) {
    lightAllowed += 1;
  }

  assertEquals(heavyAllowed, 12, "limit=100 gets 12 requests per minute");
  assertEquals(lightAllowed, 60, "limit=24 keeps the full 60 per minute");
});

Deno.test("budget refills over time and reports a usable Retry-After", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(60, clock.now);
  for (let index = 0; index < 60; index += 1) {
    limiter.consume("client", 1);
  }

  const blocked = limiter.consume("client", 1);
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.retryAfterSeconds >= 1, true, "Retry-After is always actionable");

  // One token per second at 60/min.
  clock.advanceMs(1_000);
  assertEquals(limiter.consume("client", 1).allowed, true, "a token is back after a second");

  clock.advanceMs(60_000);
  const refilled = limiter.consume("client", 1);
  assertEquals(refilled.allowed, true);
  assertEquals(refilled.remaining, 59, "a full idle minute restores the whole budget");
});

Deno.test("an allowed request reports no Retry-After", () => {
  const limiter = new RateLimiter(60, fakeClock().now);
  assertEquals(limiter.consume("client", 1).retryAfterSeconds, 0);
});

Deno.test("repeat offenders are logged at most once per minute", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(1, clock.now);
  limiter.consume("flooder", 1);

  assertEquals(limiter.consume("flooder", 1).shouldLog, true, "first rejection is logged");
  assertEquals(limiter.consume("flooder", 1).shouldLog, false, "retries stay quiet");

  clock.advanceMs(60_000);
  // The refill above grants a token, so spend it before checking the next rejection.
  limiter.consume("flooder", 1);
  assertEquals(limiter.consume("flooder", 1).shouldLog, true, "logs again after a minute");
});

Deno.test("idle clients are swept so the map stays bounded", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(60, clock.now);
  limiter.consume("transient", 1);
  assertEquals(limiter.trackedClients, 1);

  clock.advanceMs(180_000);
  limiter.consume("current", 1);
  assertEquals(limiter.trackedClients, 1, "the long-idle bucket was dropped");
});

Deno.test("a full agenda of page thumbnails fits inside one minute's budget", () => {
  const thumbnail = (id: string) =>
    new URL(`https://openbesluitvorming.nl/api/entities/${encodeURIComponent(id)}/pdf/page/1`);

  // The Utrecht raad of 29 January 2026: 151 document thumbnails and 39 motion
  // thumbnails on a single meeting sheet. At a unit each, only a third drew.
  const limiter = new RateLimiter(60, fakeClock().now);
  let drawn = 0;
  for (let index = 0; index < 190; index += 1) {
    if (limiter.consume("browser", requestCost(thumbnail(`document:x:${index}`))).allowed) {
      drawn += 1;
    }
  }
  assertEquals(drawn, 190, "every thumbnail on a long agenda should be served");

  // Still not free: a client doing nothing but thumbnails is bounded.
  const exhausted = new RateLimiter(60, fakeClock().now);
  let served = 0;
  while (exhausted.consume("scraper", requestCost(thumbnail("document:x:1"))).allowed) {
    served += 1;
    if (served > 10_000) break;
  }
  assertEquals(served, 480, "the budget still runs out, eight thumbnails to the unit");

  // A deeper page in the viewer is charged the same as the first.
  assertEquals(
    requestCost(thumbnail("document:x:1")),
    requestCost(new URL("https://openbesluitvorming.nl/api/entities/doc/pdf/page/42")),
  );
  // The proxy that streams the whole file is not a thumbnail.
  assertEquals(requestCost(new URL("https://openbesluitvorming.nl/api/entities/doc/pdf")), 1);
});
