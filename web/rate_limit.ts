/** Token-bucket rate limiting for the public /api/* surface.
 *
 * Kept separate from server.ts so the arithmetic is unit-testable: a mistake
 * here hands every reuser a 429, so it should not be verifiable only in
 * production.
 *
 * Background: /api/* had no throttling at any layer (the Caddyfile proxies it
 * straight through, and standard caddy:2 ships no rate_limit module). On
 * 2026-07-26 one consumer fanned out concurrent `limit=100` searches -- 219 of
 * that window's 580 slow requests arrived in ~5 minutes -- saturating the
 * 4-vCPU host and evicting live splits from Quickwit's cache for everybody.
 */

/** Search cost is charged per page of this size, matching the UI's PAGE_SIZE,
 * so ordinary browsing and paging cost exactly one unit. */
export const RATE_LIMIT_PAGE_UNIT = 24;

export interface RateVerdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the bucket is back at full capacity. */
  resetSeconds: number;
  /** Seconds until this specific request would fit. 0 when allowed. */
  retryAfterSeconds: number;
  /** True at most once per minute per client, to bound log volume. */
  shouldLog: boolean;
}

interface RateBucket {
  tokens: number;
  updatedAt: number;
  loggedAt: number;
}

/** A heavy request is charged proportionally: `limit=100` costs 5 units, so
 * bulk scraping at the server-side cap drains the budget 5x faster than the
 * UI's default page while remaining possible. */
export function requestCost(url: URL): number {
  if (url.pathname !== "/api/search") {
    return 1;
  }
  const limit = Number(url.searchParams.get("limit") ?? String(RATE_LIMIT_PAGE_UNIT));
  if (!Number.isFinite(limit) || limit <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(limit / RATE_LIMIT_PAGE_UNIT));
}

export class RateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly capacity: number;
  private readonly tokensPerMs: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.capacity = perMinute;
    this.tokensPerMs = perMinute / 60_000;
    this.now = now;
    this.lastSweep = now();
  }

  /** Number of tracked clients; exposed so tests can assert the sweep. */
  get trackedClients(): number {
    return this.buckets.size;
  }

  consume(key: string, cost: number): RateVerdict {
    const now = this.now();
    this.sweep(now);

    const bucket = this.buckets.get(key) ??
      { tokens: this.capacity, updatedAt: now, loggedAt: 0 };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.updatedAt) * this.tokensPerMs,
    );
    bucket.updatedAt = now;

    const allowed = bucket.tokens >= cost;
    if (allowed) {
      bucket.tokens -= cost;
    }
    const shouldLog = !allowed && now - bucket.loggedAt >= 60_000;
    if (shouldLog) {
      bucket.loggedAt = now;
    }
    this.buckets.set(key, bucket);

    const deficit = allowed ? 0 : cost - bucket.tokens;
    return {
      allowed,
      limit: this.capacity,
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      resetSeconds: Math.ceil((this.capacity - bucket.tokens) / this.tokensPerMs / 1000),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(deficit / this.tokensPerMs / 1000)),
      shouldLog,
    };
  }

  /** Buckets idle long enough to have refilled completely carry no state, so
   * dropping them keeps the map bounded under scanner/botnet traffic. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) {
      return;
    }
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 120_000) {
        this.buckets.delete(key);
      }
    }
  }
}
