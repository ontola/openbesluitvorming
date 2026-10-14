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
