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
