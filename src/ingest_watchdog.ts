/**
 * Progress watchdog for long-running ingest work.
 *
 * `executeIngest` can hang indefinitely without resolving or throwing (a wedged
 * extraction-service connection was observed freezing every worker for ~38h).
 * `raceStallWatchdog` runs such work while watching a heartbeat: if no heartbeat
 * arrives within `stallTimeoutMs`, it rejects with `IngestStallError` so the
 * caller can abandon the work and free the slot — even though the work promise
 * itself may still be pending.
 */

/** Raised when watched work emits no heartbeat within the stall timeout. */
export class IngestStallError extends Error {
  constructor(stallTimeoutMs: number) {
    super(`no progress for ${Math.round(stallTimeoutMs / 1000)}s`);
    this.name = "IngestStallError";
  }
}

/**
 * Runs `work`, handing it a `heartbeat` callback it must invoke on every sign
 * of progress.
 *
 * - If `work` settles first, its result (or rejection) passes straight through.
 * - If `work` goes silent for longer than `stallTimeoutMs`, the returned promise
 *   rejects with `IngestStallError`. `work` is left running detached; a late
 *   rejection from it is swallowed so it can't surface as unhandled.
 */
export function raceStallWatchdog<T>(options: {
  work: (heartbeat: () => void) => Promise<T>;
  stallTimeoutMs: number;
  /** How often to check for a stall. Defaults to 30s. */
  checkIntervalMs?: number;
}): Promise<T> {
  const checkIntervalMs = options.checkIntervalMs ?? 30_000;
  let lastHeartbeat = Date.now();

  const workPromise = options.work(() => {
    lastHeartbeat = Date.now();
  });
  // If the watchdog wins the race, workPromise is left dangling — make sure a
  // late rejection from the abandoned work doesn't surface as unhandled.
  void workPromise.catch(() => {});

  const watchdog = new Promise<never>((_, reject) => {
    const timer = setInterval(() => {
      if (Date.now() - lastHeartbeat > options.stallTimeoutMs) {
        clearInterval(timer);
        reject(new IngestStallError(options.stallTimeoutMs));
      }
    }, checkIntervalMs);
    // Clear the timer once the work settles. `.finally` re-raises a rejection,
    // so the `.catch` keeps this bookkeeping chain from dangling.
    void workPromise.finally(() => clearInterval(timer)).catch(() => {});
  });

  return Promise.race([workPromise, watchdog]);
}
