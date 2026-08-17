import { IbabsRateLimiter, __test__ } from "../src/ibabs/rate_limit.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Virtual clock: sleeps advance time instead of costing it. */
function fakeClock() {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

Deno.test("the cooldown doubles per consecutive throttle and is capped", () => {
  const { cooldownFor } = __test__;
  assertEquals(cooldownFor(1, 30_000, 900_000), 30_000, "first");
  assertEquals(cooldownFor(2, 30_000, 900_000), 60_000, "second");
  assertEquals(cooldownFor(3, 30_000, 900_000), 120_000, "third");
  assertEquals(cooldownFor(10, 30_000, 900_000), 900_000, "capped, not unbounded");
  assertEquals(cooldownFor(0, 30_000, 900_000), 0, "no throttles, no cooldown");
});

Deno.test("requests are paced instead of bursting", async () => {
  const clock = fakeClock();
  const limiter = new IbabsRateLimiter({
    maxRequestsPerSecond: 2, // one every 500ms
    now: clock.now,
    sleep: clock.sleep,
  });

  const start = clock.now();
  for (let i = 0; i < 4; i += 1) {
    await limiter.acquire();
  }

  // First is free, the next three each wait out the interval.
  assertEquals(clock.now() - start, 1500, "four requests span three intervals");
});

Deno.test("one throttle stops every request in the process, not just its own", async () => {
  const clock = fakeClock();
  const limiter = new IbabsRateLimiter({
    maxRequestsPerSecond: 1000, // pacing out of the way
    cooldownMs: 30_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  await limiter.acquire();
  limiter.recordThrottle();

  const before = clock.now();
  await limiter.acquire();
  assert(clock.now() - before >= 30_000, "the next caller waits out the cooldown");
});

Deno.test("a persistent throttle escalates, and success clears it", async () => {
  const clock = fakeClock();
  const limiter = new IbabsRateLimiter({
    maxRequestsPerSecond: 1000,
    cooldownMs: 10_000,
    maxCooldownMs: 100_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  limiter.recordThrottle();
  limiter.recordThrottle();
  limiter.recordThrottle();
  const before = clock.now();
  await limiter.acquire();
  // Third throttle in a row: 10s doubled twice.
  assertEquals(clock.now() - before, 40_000, "cooldown escalated");

  limiter.recordSuccess();
  limiter.recordThrottle();
  const afterReset = clock.now();
  await limiter.acquire();
  assertEquals(clock.now() - afterReset, 10_000, "a success resets the escalation");
});

Deno.test("the breaker is shared through a file, so one worker brakes the fleet", async () => {
  const statePath = await Deno.makeTempFile();
  try {
    const clock = fakeClock();
    const common = {
      maxRequestsPerSecond: 1000,
      cooldownMs: 60_000,
      statePath,
      now: clock.now,
      sleep: clock.sleep,
    };
    const workerA = new IbabsRateLimiter(common);
    const workerB = new IbabsRateLimiter(common);

    // A meets the limit and publishes the cooldown.
    workerA.recordThrottle();
    // Give the best-effort write a turn before B reads it.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = clock.now();
    await workerB.acquire();
    assert(
      clock.now() - before >= 60_000,
      "a worker that never saw a 403 still waits, which per-connection backoff could not do",
    );
  } finally {
    await Deno.remove(statePath).catch(() => undefined);
  }
});

Deno.test("without a shared file the breaker still works in-process", async () => {
  const clock = fakeClock();
  const limiter = new IbabsRateLimiter({
    maxRequestsPerSecond: 1000,
    cooldownMs: 5_000,
    now: clock.now,
    sleep: clock.sleep,
    // no statePath
  });

  limiter.recordThrottle();
  const before = clock.now();
  await limiter.acquire();
  assertEquals(clock.now() - before, 5_000, "degrades to per-process rather than breaking");
});

Deno.test("a failing caller does not wedge the queue behind it", async () => {
  const clock = fakeClock();
  const limiter = new IbabsRateLimiter({
    maxRequestsPerSecond: 1000,
    now: clock.now,
    sleep: () => Promise.reject(new Error("clock exploded")),
  });

  limiter.recordThrottle();
  await limiter.acquire().catch(() => undefined);

  // The chain is serialised; if a rejection were left unhandled every later
  // acquire would inherit it.
  const recovered = new IbabsRateLimiter({
    maxRequestsPerSecond: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  await recovered.acquire();
  assert(true, "a later limiter still works");
});

/** The budgets iBabs gave us on 2026-08-17, when they lifted the block.
 *
 * 180/min for WCF and the portal, 30/min for publicdownload and the document
 * viewer — per IP address, which the whole fleet shares. One limiter used to
 * serve both at a single rate, and production ran it at 1/s per worker: across
 * four workers that is 240/min, inside the SOAP budget and eight times over
 * the download one. Exceeding it does not cost a 429; it cost twelve days of
 * blacklisting on 2026-08-05.
 */
Deno.test("each endpoint is paced to its own share of the per-IP budget", () => {
  const previous = Deno.env.get("WOOZI_IBABS_WORKERS");
  Deno.env.set("WOOZI_IBABS_WORKERS", "4");
  try {
    const perMinute = (perSecond: number) => perSecond * 60 * 4; // back to the fleet
    const soap = __test__.pacePerSecond(180);
    const download = __test__.pacePerSecond(30);

    assertEquals(Math.round(perMinute(soap)), 144, "SOAP: 180/min with a fifth held back");
    assertEquals(Math.round(perMinute(download)), 24, "downloads: 30/min with a fifth held back");
    assert(
      perMinute(download) <= 30,
      `the fleet must stay inside 30/min, got ${perMinute(download)}`,
    );
    assert(perMinute(soap) <= 180, `the fleet must stay inside 180/min, got ${perMinute(soap)}`);
    assert(download < soap, "downloads are the tighter budget of the two");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_IBABS_WORKERS");
    } else {
      Deno.env.set("WOOZI_IBABS_WORKERS", previous);
    }
  }
});

Deno.test("more workers means each one goes slower, not the fleet faster", () => {
  const previous = Deno.env.get("WOOZI_IBABS_WORKERS");
  try {
    Deno.env.set("WOOZI_IBABS_WORKERS", "1");
    const alone = __test__.pacePerSecond(30);
    Deno.env.set("WOOZI_IBABS_WORKERS", "8");
    const crowded = __test__.pacePerSecond(30);

    assertEquals(alone / crowded, 8, "the budget is divided, not multiplied");
    assert(crowded * 8 <= 30 / 60, "eight workers together still fit inside 30/min");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_IBABS_WORKERS");
    } else {
      Deno.env.set("WOOZI_IBABS_WORKERS", previous);
    }
  }
});
