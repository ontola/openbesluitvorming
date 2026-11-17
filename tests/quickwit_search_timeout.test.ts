import { assertEquals, assertRejects } from "jsr:@std/assert";
import { __test__, QuickwitClient, SearchTimeoutError } from "../src/quickwit/client.ts";

Deno.test("a search timeout is not retried (#348)", () => {
  const timeout = new Error("Signal timed out.");
  timeout.name = "TimeoutError";
  assertEquals(__test__.isRetryableSearchError(timeout), false);
  assertEquals(
    __test__.isRetryableSearchError(new Error("Quickwit request failed 500: boom")),
    true,
  );
});

Deno.test("a search that exceeds the budget fails once as SearchTimeoutError", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = Deno.env.get("QUICKWIT_SEARCH_TIMEOUT_MS");
  let calls = 0;
  Deno.env.set("QUICKWIT_SEARCH_TIMEOUT_MS", "20");
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as typeof fetch;
  try {
    await assertRejects(
      () => new QuickwitClient().searchRequest({ query: "*" }),
      SearchTimeoutError,
    );
    assertEquals(calls, 1, "one attempt, not two");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) Deno.env.delete("QUICKWIT_SEARCH_TIMEOUT_MS");
    else Deno.env.set("QUICKWIT_SEARCH_TIMEOUT_MS", originalTimeout);
  }
});

Deno.test("a request can be given less than the whole budget", async () => {
  const originalFetch = globalThis.fetch;
  let error: unknown;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const started = performance.now();
  try {
    await new QuickwitClient().searchRequest({ query: "*" }, { timeoutMs: 20 });
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(error instanceof SearchTimeoutError, true);
  assertEquals((error as SearchTimeoutError).timeoutMs, 20);
  assertEquals(performance.now() - started < 2000, true, "did not wait the default 8 s");
});
