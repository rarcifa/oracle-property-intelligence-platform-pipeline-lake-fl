/**
 * `/api/chat` costs money per call and is public and unauthenticated.
 *
 * Reserved concurrency caps how many run at once; it does nothing about how
 * many a single caller may make in a minute. A scraper could spend the account's
 * model budget without ever tripping it — which is exactly how the agent went
 * dark mid-evaluation once already.
 *
 * These tests pin the bucket itself. They deliberately do NOT claim an aggregate
 * limit: the bucket is per-container, so a deployed burst can spread across
 * containers and every request can succeed. That was measured on the deployed
 * runtime — 16 concurrent calls, 16x200 — after an earlier identical run had
 * shown 10x200/6x429 and been reported as proof it worked. It was not.
 */
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/chat/rate-limit.js";

describe("createRateLimiter", () => {
  it("allows a normal burst", () => {
    const limiter = createRateLimiter({ capacity: 5, refillPerMinute: 5 });
    for (let i = 0; i < 5; i += 1) expect(limiter.take("1.2.3.4").allowed).toBe(true);
  });

  it("refuses once the caller's budget is spent", () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerMinute: 3 });
    for (let i = 0; i < 3; i += 1) limiter.take("1.2.3.4");
    const verdict = limiter.take("1.2.3.4");
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("budgets each caller separately", () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerMinute: 2 });
    limiter.take("1.1.1.1");
    limiter.take("1.1.1.1");
    expect(limiter.take("1.1.1.1").allowed).toBe(false);
    expect(limiter.take("2.2.2.2").allowed).toBe(true);
  });

  it("refills over time", () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 2, refillPerMinute: 60, now: () => now });
    limiter.take("a");
    limiter.take("a");
    expect(limiter.take("a").allowed).toBe(false);
    now += 1100; // one token per second at 60/min
    expect(limiter.take("a").allowed).toBe(true);
  });

  it("does not grow without bound as callers come and go", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerMinute: 60, maxTracked: 3 });
    for (let i = 0; i < 50; i += 1) limiter.take(`caller-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
