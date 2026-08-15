import { IbabsBlockedError, __test__ } from "../src/ibabs/client.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** A block and a throttle both arrive as 403 and behave nothing alike.
 *
 * iBabs blocked the production address on 2026-08-05. Ten days later it was
 * still blocked: 166 scheduled runs a night, 0 successes, 90 municipalities
 * with no updates at all. The rate limiter treated every one of those 403s as
 * "slow down" and waited -- the fleet-wide breaker backing off up to 15
 * minutes at a time -- for a condition that does not clear by waiting. Each
 * run then held a worker slot until the stall watchdog abandoned it.
 *
 * Verified from two addresses: 403 "The request is blocked." in 43ms from the
 * server, 200 with a valid SOAP response from elsewhere.
 */
Deno.test("a blocked address is reported as blocked, not as throttling", async () => {
  const originalFetch = globalThis.fetch;
  let pogingen = 0;

  globalThis.fetch = async () => {
    pogingen += 1;
    return new Response(
      "<html><body><h1>Error 403 - Forbidden</h1><p>The request is blocked.</p></body></html>",
      { status: 403 },
    );
  };

  try {
    let gevangen: unknown;
    try {
      await __test__.fetchText("https://wcf.ibabs.eu/api/Public.svc", { method: "POST" });
    } catch (error) {
      gevangen = error;
    }

    assert(gevangen instanceof IbabsBlockedError, `expected a block, got ${gevangen}`);
    assert(
      String((gevangen as Error).message).includes("does not clear by waiting"),
      "the message has to say the waiting is pointless",
    );
    assert(pogingen === 1, `a block must not be retried, made ${pogingen} attempts`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** The distinction has to hold on the body, because the status cannot carry
 * it: iBabs answers 403 for both. Driven directly rather than through
 * fetchText, which would sit out the real backoff curve for the throttle. */
Deno.test("an ordinary 403 is still read as throttling", () => {
  const { looksLikeHardBlock, isThrottleError, IbabsHttpError } = __test__;

  assert(
    looksLikeHardBlock("<html><body><p>The request is blocked.</p></body></html>"),
    "the block page has to be recognised",
  );
  assert(
    !looksLikeHardBlock("<html><body>Rate limit exceeded, try again later</body></html>"),
    "a throttle body must not be mistaken for a block",
  );
  assert(!looksLikeHardBlock(""), "an empty body is not evidence of a block");

  // Unchanged: without the block page, 403 and 429 stay throttles.
  assert(
    isThrottleError(new IbabsHttpError(403, "https://wcf.ibabs.eu/api/Public.svc")),
    "403 without the block page is still a throttle",
  );
  assert(
    isThrottleError(new IbabsHttpError(429, "https://wcf.ibabs.eu/api/Public.svc")),
    "429 is still a throttle",
  );
});
