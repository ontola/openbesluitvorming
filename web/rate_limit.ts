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

/** The largest page /api/search will return -- `search_api.ts` clamps to it.
 * Charging past it would bill for rows the API was never going to send. */
const MAX_SEARCH_LIMIT = 100;

/** Rows above the free page that together add one unit to a search.
 *
 * The first model charged a unit per 24 rows, on the assumption that a search
 * costs what it hands back. Measured against production on 2026-08-26, warm,
 * five repetitions per size: `limit=1` took 1.15s, `limit=24` 1.44s and
 * `limit=100` 1.61s. A search is a query evaluated over the splits -- that is
 * the 1.15s, and it is charged whatever the page size -- plus some 4.6ms per
 * row returned. One base search therefore buys about 250 further rows, not 24.
 *
 * Being ten times too steep is the smaller half of it. The old price was
 * highest for the *cheapest* way to read the corpus: 1000 results at `limit=24`
 * is 42 requests and about 60s of server time, charged 42 units, while the same
 * 1000 at `limit=100` is 10 requests and 16s, charged 50. Pricing the marginal
 * row at what it measures makes the fewer, larger requests the cheap option for
 * the consumer too, which is also the traffic we would rather have (#225). */
const ROWS_PER_EXTRA_UNIT = 250;

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

/** A rendered PDF page is a cached image, not a query, and one meeting page
 * asks for as many as it has attachments. The Utrecht raad of 29 January 2026
 * requests 190 of them; at a full unit each that drains a 60/minute budget
 * before a third of the agenda has drawn, which is why most thumbnails on a
 * long agenda were broken. A fraction lets a whole agenda through while a
 * cold render -- the only genuinely expensive case -- still costs something. */
const PDF_PAGE_COST = 1 / 8;

const PDF_PAGE_PATH = /\/pdf\/page\/\d+$/;

/** A larger page is charged for the rows it adds, not for the query it repeats:
 * `limit=100` costs 1.3 units. What actually protects the host from the fan-out
 * of 2026-07-26 is the per-minute budget itself -- at 1.44s against 1.61s a
 * server, sixty `limit=24` searches were always about as heavy as sixty
 * `limit=100` ones, so the old multiplier bought almost no protection and
 * charged honest bulk readers five times over for it. */
export function requestCost(url: URL): number {
  if (PDF_PAGE_PATH.test(url.pathname)) {
    return PDF_PAGE_COST;
  }
  if (url.pathname !== "/api/search") {
    return 1;
  }
  const limit = Number(url.searchParams.get("limit") ?? String(RATE_LIMIT_PAGE_UNIT));
  if (!Number.isFinite(limit) || limit <= 0) {
    return 1;
  }
  const billable = Math.min(limit, MAX_SEARCH_LIMIT);
  return 1 + Math.max(0, billable - RATE_LIMIT_PAGE_UNIT) / ROWS_PER_EXTRA_UNIT;
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

    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now, loggedAt: 0 };
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
