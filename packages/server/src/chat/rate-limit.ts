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

/**
 * Default budget per caller, per container.
 *
 * Measured rather than assumed, and the first measurement was wrong: 16
 * concurrent calls once returned 10x200 and 6x429, which looked like the limiter
 * working, and a later identical run returned 16x200. The difference was how
 * many containers Lambda happened to spin up. Each has its own bucket, so under
 * fan-out this bounds a caller per container and NOT in aggregate.
 *
 * The real worst case is `reservedConcurrentExecutions` x `refillPerMinute`,
 * so these numbers are set to make that number defensible: 5/min x 25 = 125
 * requests per minute, not the 250 the previous values allowed. A genuine
 * aggregate limit needs shared state, which the no-ongoing-cost design rules
 * out — so the honest move is to bound what can be bounded and say plainly what
 * this does not do.
 */
export const DEFAULT_CHAT_RATE_LIMIT: RateLimiterOptions = {
  capacity: 5,
  refillPerMinute: 5,
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

/**
 * The caller, as well as a Function URL allows.
 *
 * `x-forwarded-for` is client-supplied and spoofable, so every limit built on it
 * bounds honest traffic and cost rather than defeating a determined attacker.
 * Saying so is part of the contract.
 */
export function callerOf(headers: Record<string, string | undefined>): string {
  const forwarded = headers["x-forwarded-for"] ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

/**
 * Budget for the compute surfaces.
 *
 * `/api/sql` and `/mcp` cost no money but they are unauthenticated compute over
 * a 215,806-row table, and they had no limit of any kind. This is deliberately
 * generous — the UI itself issues bursts while a page loads — and still bounds a
 * scraper. Same per-container caveat as the chat bucket: with reserved
 * concurrency of 25 the aggregate ceiling is 25x this.
 */
export const DEFAULT_QUERY_RATE_LIMIT: RateLimiterOptions = {
  capacity: 120,
  refillPerMinute: 120,
};
