import { DEFAULT_MAX_COOLDOWN_MS } from "../src/ibabs/rate_limit.ts";
import { DELIBERATE_WAIT_MARGIN_MS, ingestStallTimeoutMs } from "../src/ingest_stall_timeout.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** The stall watchdog must outlast every wait the pipeline takes on purpose.
 *
 * The iBabs breaker holds every request in a process for up to 15 minutes when
 * the API throttles. A run sleeping there is behaving as designed, but it emits
 * no progress, and the watchdog cannot tell that apart from a wedged
 * connection. The watchdog sat at 10 minutes against that 15, so every iBabs
 * import that reached a full-length cooldown was abandoned before it could
 * resume: 90 of 90 scheduled runs a night, each with zero entities and not one
 * log line, from at least 10 August until this was measured on the 14th.
 *
 * Neither number was wrong on its own. They were written in different files by
 * different changes, and nothing recorded that one bounds the other.
 */
Deno.test("the watchdog outlasts the longest deliberate backoff", () => {
  const timeout = ingestStallTimeoutMs(() => undefined);

  assert(
    timeout > DEFAULT_MAX_COOLDOWN_MS,
    `watchdog ${timeout}ms must outlast breaker ${DEFAULT_MAX_COOLDOWN_MS}ms`,
  );
  assert(
    timeout - DEFAULT_MAX_COOLDOWN_MS >= 60_000,
    "there must be room to resume after the cooldown, not merely to wake up",
  );
});

Deno.test("a longer breaker drags the watchdog with it", () => {
  // The point of deriving it: raising one cannot silently invalidate the other.
  const langer = 30 * 60_000;
  const timeout = ingestStallTimeoutMs(() => undefined, langer);

  assert(timeout === langer + DELIBERATE_WAIT_MARGIN_MS, `unexpected: ${timeout}`);
});

Deno.test("an explicit override still wins, with a floor", () => {
  assert(ingestStallTimeoutMs(() => "1800000") === 1_800_000, "an operator can set it directly");
  assert(ingestStallTimeoutMs(() => "1000") === 60_000, "but not below the floor");
  assert(
    ingestStallTimeoutMs(() => "onzin") > DEFAULT_MAX_COOLDOWN_MS,
    "an unparseable value falls back to the derived timeout, not to nothing",
  );
});
