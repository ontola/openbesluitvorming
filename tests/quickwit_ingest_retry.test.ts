import { __test__ } from "../src/quickwit/client.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const { isRetryableIngestError, shouldHalveBatch } = __test__;

/** A reindex run covers a whole source, so one transient rejection used to
 * throw away hours of work.
 *
 * Four of 325 sources died this way during the v3 reindex, each at an
 * arbitrary point, on `413 The request payload is too large` while 32 ingests
 * ran at once. The retry predicate matched only "index not found", so every
 * other failure was final. */
Deno.test("a transient ingest failure is retried, not fatal", () => {
  const transient = [
    'Quickwit ingest failed 413: {"message": "The request payload is too large"}',
    "Quickwit ingest failed 429: too many requests",
    "Quickwit ingest failed 503: service unavailable",
    "error sending request for url (http://quickwit:7280/...)",
    "connection reset by peer",
    // The one that killed the retry of de_ronde_venen, minutes after the
    // predicate had been widened for everything else.
    "error reading a body from connection",
  ];

  for (const message of transient) {
    assert(isRetryableIngestError(new Error(message)), `should retry: ${message}`);
  }

  const timeout = new Error("signal timed out");
  timeout.name = "TimeoutError";
  assert(isRetryableIngestError(timeout), "a timed-out ingest is worth another attempt");
});

Deno.test("the retry that already worked keeps working", () => {
  assert(
    isRetryableIngestError(new Error("Quickwit ingest failed 404: index not found")),
    "a missing index is still retried while it is being created",
  );
});

Deno.test("a genuine rejection is not retried forever", () => {
  assert(
    !isRetryableIngestError(new Error("Quickwit ingest failed 400: malformed document")),
    "a bad request will not become good by repeating it",
  );
  assert(!isRetryableIngestError("niet eens een error"), "a non-error is not retryable");
});

/** 413 is the one case where resending the same bytes may not help, so the
 * batch is halved as well as retried. That covers both causes: backpressure,
 * where the same body lands moments later, and a body that really is too big. */
Deno.test("only an oversized-payload rejection asks for a smaller batch", () => {
  assert(
    shouldHalveBatch(new Error('Quickwit ingest failed 413: {"message": "too large"}')),
    "413 should halve the batch",
  );
  assert(
    !shouldHalveBatch(new Error("Quickwit ingest failed 503: service unavailable")),
    "a server error should be retried as-is, not split",
  );
});
