/** How long a run may emit no progress before the worker treats it as wedged.
 *
 * Kept out of worker.ts so it can be checked without starting a worker, for
 * the same reason rate_limit.ts and search_params.ts live on their own.
 *
 * The number is derived rather than written down, because it is not
 * independent: it has to outlast the longest wait the pipeline takes on
 * purpose. The iBabs breaker holds every request in a process for up to 15
 * minutes when the API throttles, and a run sleeping there emits nothing the
 * watchdog can distinguish from a stuck connection.
 *
 * With the watchdog at 10 minutes against that 15, every iBabs import that
 * reached a full-length cooldown was abandoned before it could resume: 90 of
 * 90 scheduled runs a night, each ending with zero entities and not one log
 * line, from at least 10 August until it was measured on the 14th. Neither
 * number was wrong on its own -- they were written in different files by
 * different changes, and nothing recorded that one bounds the other.
 */
import { DEFAULT_MAX_COOLDOWN_MS } from "./ibabs/rate_limit.ts";

/** Room to actually resume after the cooldown ends. A margin of seconds would
 * satisfy the constraint and still kill the run on its first request back. */
export const DELIBERATE_WAIT_MARGIN_MS = 5 * 60_000;

/** Never below this, however the inputs are configured. */
const FLOOR_MS = 60_000;

export function ingestStallTimeoutMs(
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
  maxDeliberateWaitMs: number = DEFAULT_MAX_COOLDOWN_MS,
): number {
  const override = Number(env("INGEST_STALL_TIMEOUT_MS") ?? "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(FLOOR_MS, override);
  }

  return Math.max(FLOOR_MS, maxDeliberateWaitMs + DELIBERATE_WAIT_MARGIN_MS);
}
