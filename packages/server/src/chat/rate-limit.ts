/**
 * A per-caller token bucket for the one endpoint that costs money.
 *
 * `/api/chat` is public and unauthenticated by design, and every call spends
 * model credit. Reserved concurrency caps how many run at once and says nothing
 * about how many one caller may make in a minute, so a scraper could drain the
 * account's budget without ever tripping it — which is not hypothetical: the
 * agent went dark mid-evaluation on exhausted credit.
 *
 * In-memory and therefore per-container, which is a real limitation and is
 * stated rather than papered over: with reserved concurrency of 25 the effective
 * ceiling is up to 25× the configured rate. That is a bound where there was
 * none, and it needs no datastore, which the no-ongoing-cost design rules out.
 */

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** How long to wait before the next token, when refused. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  take(caller: string): RateLimitVerdict;
  /** Number of callers currently tracked. Exposed so the bound is testable. */
  size(): number;
}

export interface RateLimiterOptions {
  /** Burst size: tokens a fresh caller may spend immediately. */
  readonly capacity: number;
  /** Tokens returned per minute. */
  readonly refillPerMinute: number;
  /** Cap on tracked callers, so the map cannot grow without bound. */
  readonly maxTracked?: number;
  /** Injectable clock, for tests. */
  readonly now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Default: enough for real use, far below what a scraper wants. */
export const DEFAULT_CHAT_RATE_LIMIT: RateLimiterOptions = {
  capacity: 10,
  refillPerMinute: 10,
};

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerMinute } = options;
  const maxTracked = options.maxTracked ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const perMs = refillPerMinute / 60_000;
  const buckets = new Map<string, Bucket>();

  return {
    take(caller: string): RateLimitVerdict {
      const at = now();
      const bucket = buckets.get(caller) ?? { tokens: capacity, updatedAt: at };
      bucket.tokens = Math.min(capacity, bucket.tokens + (at - bucket.updatedAt) * perMs);
      bucket.updatedAt = at;

      // Re-inserting moves the caller to the end of the Map's insertion order,
      // so the eviction below drops the least recently seen rather than a
      // random one.
      buckets.delete(caller);
      buckets.set(caller, bucket);
      if (buckets.size > maxTracked) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / (perMs * 1000))),
      };
    },
    size(): number {
      return buckets.size;
    },
  };
}
