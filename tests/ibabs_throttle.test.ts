// The throttle base delay is read from the environment at module load, so it
// has to be set before the client is imported.
Deno.env.set("WOOZI_IBABS_THROTTLE_BASE_MS", "1");

const { __test__ } = await import("../src/ibabs/client.ts");

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

/** Replace global fetch with a scripted sequence of responses. */
function stubFetch(steps: Array<Response | Error>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let index = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step.clone());
  }) as typeof fetch;
  return {
    calls,
    get attempts() {
      return index;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const ok = (body = "<ok/>") => new Response(body, { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("", { status: code, headers });

Deno.test("403 and 429 are treated as throttles, other statuses are not", () => {
  const { isThrottleError, IbabsHttpError } = __test__;
  assert(isThrottleError(new IbabsHttpError(403, "u")), "403 is a throttle");
  assert(isThrottleError(new IbabsHttpError(429, "u")), "429 is a throttle");
  assert(!isThrottleError(new IbabsHttpError(404, "u")), "404 is not");
  assert(!isThrottleError(new IbabsHttpError(500, "u")), "500 is not a throttle");
  assert(!isThrottleError(new Error("Request failed 403 for u")), "a plain Error is not");
});

Deno.test("the throttle message keeps the shape other layers match on", () => {
  const error = new __test__.IbabsHttpError(403, "https://wcf.ibabs.eu/api/Public.svc");
  assertEquals(
    error.message,
    "Request failed 403 for https://wcf.ibabs.eu/api/Public.svc",
    "message unchanged",
  );
});

Deno.test("throttle backoff grows, and Retry-After wins when the server sends one", () => {
  const { throttleDelayMs, parseRetryAfter } = __test__;
  // Base is 1ms in this test, so the curve is 1, 2, 4, 8.
  assertEquals([1, 2, 3, 4].map((a) => throttleDelayMs(a)), [1, 2, 4, 8], "doubles per attempt");
  assertEquals(throttleDelayMs(1, 5_000), 5_000, "Retry-After overrides the curve");

  assertEquals(parseRetryAfter("30"), 30_000, "seconds become milliseconds");
  assertEquals(parseRetryAfter(null), undefined, "absent header");
  assertEquals(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"), undefined, "date form ignored");
});

Deno.test("a throttled request is retried and eventually succeeds", async () => {
  const stub = stubFetch([status(403), status(403), ok("<recovered/>")]);
  try {
    const body = await __test__.fetchText("https://example.test/soap", { method: "POST" });
    assertEquals(body, "<recovered/>", "returns the successful response");
    assertEquals(stub.attempts, 3, "two throttles then a success");
  } finally {
    stub.restore();
  }
});

Deno.test("a persistent throttle gives up after its own budget, not the transport one", async () => {
  const stub = stubFetch([status(429)]);
  try {
    let thrown: unknown;
    try {
      await __test__.fetchText("https://example.test/soap", { method: "POST" });
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Error, "still fails in the end");
    assert(String(thrown).includes("429"), "reports the status");
    // 1 initial + 4 throttle retries. The old code would have stopped at 3,
    // all within a second — far too quick for a rate limit.
    assertEquals(stub.attempts, 5, "uses the throttle budget");
  } finally {
    stub.restore();
  }
});

Deno.test("a hard error is not retried as if it were a throttle", async () => {
  const stub = stubFetch([status(404)]);
  try {
    let thrown: unknown;
    try {
      await __test__.fetchText("https://example.test/soap", { method: "POST" });
    } catch (error) {
      thrown = error;
    }
    assert(String(thrown).includes("404"), "surfaces the 404");
    assertEquals(stub.attempts, 1, "no retries for a genuine client error");
  } finally {
    stub.restore();
  }
});

Deno.test("connection drops keep their own short budget", async () => {
  const stub = stubFetch([new Error("connection reset by peer")]);
  try {
    let thrown: unknown;
    try {
      await __test__.fetchText("https://example.test/soap", { method: "POST" });
    } catch (error) {
      thrown = error;
    }
    assert(String(thrown).includes("connection reset"), "surfaces the transport error");
    assertEquals(stub.attempts, 3, "three transport attempts, unchanged from before");
  } finally {
    stub.restore();
  }
});

Deno.test("throttles and connection drops do not consume each other's budget", async () => {
  // Two resets and two throttles interleaved: neither alone exhausts a budget,
  // so the request should still get through.
  const stub = stubFetch([
    new Error("connection reset by peer"),
    status(403),
    new Error("connection reset by peer"),
    status(429),
    ok("<through/>"),
  ]);
  try {
    const body = await __test__.fetchText("https://example.test/soap", { method: "POST" });
    assertEquals(body, "<through/>", "survives a mix of failures");
    assertEquals(stub.attempts, 5, "each failure used its own budget");
  } finally {
    stub.restore();
  }
});

Deno.test("a connection that cannot be established is retried like other transport errors", async () => {
  // Deno's wording when the socket never opens. It was the one transport
  // failure without a retry, and in production each occurrence skipped a
  // motion outright.
  const stub = stubFetch([
    new Error("error sending request for url (https://wcf.ibabs.eu/api/Public.svc)"),
    ok("<recovered/>"),
  ]);
  try {
    const body = await __test__.fetchText("https://example.test/soap", { method: "POST" });
    assertEquals(body, "<recovered/>", "recovers on the retry");
    assertEquals(stub.attempts, 2, "one failure, one success");
  } finally {
    stub.restore();
  }
});
