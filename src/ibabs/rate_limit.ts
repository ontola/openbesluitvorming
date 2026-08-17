/**
 * Fleet-wide pacing and a circuit breaker for the iBabs API.
 *
 * The per-request backoff in `client.ts` cannot coordinate: four worker
 * containers, each running several imports, each retrying independently. On
 * 2026-08-05 that added up to an IP-level block covering the SOAP endpoint,
 * the WSDL and the document host — every iBabs source, not just the motion
 * backfill that caused it. Backing off harder per connection had already been
 * tried and only made runs stall; the missing piece was a shared brake.
 *
 * Two mechanisms:
 *
 *   * Pacing — a minimum interval between requests within a process, so a
 *     single worker cannot burst.
 *   * A breaker — once the API answers 403/429, *every* request in the
 *     process stops for a cooldown that grows while the throttling persists.
 *     The cooldown is written to a file on the volume all workers share, so
 *     one worker hitting the limit slows the whole fleet.
 *
 * The shared file is best-effort. If it is unset or unwritable the breaker
 * still works per process, which is strictly better than what came before, so
 * a missing volume degrades rather than breaks.
 */

/** What iBabs allows per minute, for the whole IP address.
 *
 * Their numbers, given on 2026-08-17 when they lifted the block: 180/min for
 * the WCF endpoint and the public portal, 30/min for publicdownload and the
 * document viewer. Downloads were lowered from what they used to be, because
 * bots now spread requests over several addresses.
 *
 * These are per *IP*, and the fleet shares one, so the budget is divided by
 * the number of workers rather than granted to each of them. Going over does
 * not cost a 429 -- it cost twelve days of blacklisting on 2026-08-05 -- so
 * the pacing keeps a fifth of the budget in hand. */
const DEFAULT_SOAP_PER_MINUTE = 180;
const DEFAULT_DOWNLOAD_PER_MINUTE = 30;
const DEFAULT_WORKERS = 1;
const BUDGET_HEADROOM = 0.8;
const DEFAULT_COOLDOWN_MS = 30_000;
/** Longest the breaker will hold every request in a process.
 *
 * Exported because the worker's stall watchdog has to outlast it. A run
 * sleeping here is behaving exactly as designed, but it emits no progress
 * while it waits, and the watchdog cannot tell that apart from a wedged
 * connection. With the watchdog at 10 minutes and this at 15, every run that
 * reached a full-length cooldown was abandoned before it could resume -- 90 of
 * 90 scheduled iBabs imports, every night, with zero entities and no log line
 * (measured 2026-08-14). */
export const DEFAULT_MAX_COOLDOWN_MS = 15 * 60_000;
/** How long a read of the shared breaker file is trusted, so pacing does not
 * turn into a stat() per request. */
const SHARED_READ_TTL_MS = 1_000;

function envNumber(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** This process's share of a per-IP, per-minute budget, as requests/second. */
function pacePerSecond(perMinute: number): number {
  const workers = envNumber("WOOZI_IBABS_WORKERS", DEFAULT_WORKERS);
  return (perMinute * BUDGET_HEADROOM) / workers / 60;
}

export interface RateLimiterOptions {
  maxRequestsPerSecond?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  statePath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Cooldown after `consecutive` throttles, doubling and capped. */
export function cooldownFor(consecutive: number, baseMs: number, maxMs: number): number {
  if (consecutive <= 0) {
    return 0;
  }
  return Math.min(baseMs * 2 ** (consecutive - 1), maxMs);
}

export class IbabsRateLimiter {
  private readonly minIntervalMs: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly statePath?: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private nextSlotAt = 0;
  private consecutiveThrottles = 0;
  private blockedUntil = 0;
  private sharedReadAt = 0;
  /** Serialises acquire() so concurrent callers queue rather than all reading
   * the same slot and firing together. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    const rps = options.maxRequestsPerSecond ?? pacePerSecond(DEFAULT_SOAP_PER_MINUTE);
    this.minIntervalMs = rps > 0 ? 1000 / rps : 0;
    this.cooldownMs =
      options.cooldownMs ?? Number(Deno.env.get("WOOZI_IBABS_COOLDOWN_MS") ?? DEFAULT_COOLDOWN_MS);
    this.maxCooldownMs =
      options.maxCooldownMs ??
      Number(Deno.env.get("WOOZI_IBABS_MAX_COOLDOWN_MS") ?? DEFAULT_MAX_COOLDOWN_MS);
    this.statePath = options.statePath ?? Deno.env.get("WOOZI_IBABS_BREAKER_PATH") ?? undefined;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Wait until this process may issue the next iBabs request. */
  acquire(): Promise<void> {
    const wait = this.tail.then(() => this.reserve());
    // Keep the chain alive even when a caller rejects, or one failure would
    // wedge every later request.
    this.tail = wait.catch(() => undefined);
    return wait;
  }

  private async reserve(): Promise<void> {
    await this.refreshSharedBlock();

    const blockedFor = this.blockedUntil - this.now();
    if (blockedFor > 0) {
      await this.sleep(blockedFor);
    }

    const waitForSlot = this.nextSlotAt - this.now();
    if (waitForSlot > 0) {
      await this.sleep(waitForSlot);
    }
    this.nextSlotAt = Math.max(this.now(), this.nextSlotAt) + this.minIntervalMs;
  }

  /** Called when the API answers 403/429. Opens the breaker for everyone. */
  recordThrottle(): void {
    this.consecutiveThrottles += 1;
    const cooldown = cooldownFor(this.consecutiveThrottles, this.cooldownMs, this.maxCooldownMs);
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + cooldown);
    this.writeSharedBlock(this.blockedUntil);
    console.log(
      `[ibabs] breaker open for ${Math.round(cooldown / 1000)}s ` +
        `(throttle ${this.consecutiveThrottles} in a row)`,
    );
  }

  /** A successful call means the API is answering again. */
  recordSuccess(): void {
    this.consecutiveThrottles = 0;
  }

  private async refreshSharedBlock(): Promise<void> {
    if (!this.statePath || this.now() - this.sharedReadAt < SHARED_READ_TTL_MS) {
      return;
    }
    this.sharedReadAt = this.now();
    try {
      const raw = await Deno.readTextFile(this.statePath);
      const until = Number(JSON.parse(raw)?.blockedUntil);
      if (Number.isFinite(until)) {
        this.blockedUntil = Math.max(this.blockedUntil, until);
      }
    } catch {
      // No file yet, or unreadable: fall back to this process's own state.
    }
  }

  private writeSharedBlock(blockedUntil: number): void {
    if (!this.statePath) {
      return;
    }
    Deno.writeTextFile(this.statePath, JSON.stringify({ blockedUntil })).catch(() => {
      // Best effort. A worker that cannot write still brakes itself.
    });
  }
}

let soapLimiter: IbabsRateLimiter | null = null;
let downloadLimiter: IbabsRateLimiter | null = null;

/** Pacing for the SOAP endpoint and the WSDL: 180/min for the address.
 *
 * One limiter used to serve both this and the downloads, paced at whatever
 * WOOZI_IBABS_MAX_RPS said. That was a single number for two budgets six times
 * apart, so it was necessarily wrong for one of them: production ran it at 1/s
 * per worker, which across four workers is 240/min -- inside the SOAP budget
 * and eight times over the download one. */
export function ibabsRateLimiter(): IbabsRateLimiter {
  if (!soapLimiter) {
    soapLimiter = new IbabsRateLimiter({
      maxRequestsPerSecond: pacePerSecond(
        envNumber("WOOZI_IBABS_SOAP_PER_MINUTE", DEFAULT_SOAP_PER_MINUTE),
      ),
    });
  }
  return soapLimiter;
}

/** Pacing for publicdownload and the document viewer: 30/min for the address.
 *
 * A separate limiter, but the breaker behind it is the same file, because a
 * 403 on either host is the same address being told to stop. */
export function ibabsDownloadRateLimiter(): IbabsRateLimiter {
  if (!downloadLimiter) {
    downloadLimiter = new IbabsRateLimiter({
      maxRequestsPerSecond: pacePerSecond(
        envNumber("WOOZI_IBABS_DOWNLOAD_PER_MINUTE", DEFAULT_DOWNLOAD_PER_MINUTE),
      ),
    });
  }
  return downloadLimiter;
}

export const __test__ = { cooldownFor, pacePerSecond };
