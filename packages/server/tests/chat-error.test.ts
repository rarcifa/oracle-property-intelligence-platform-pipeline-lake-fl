/**
 * The agent's upstream failures must not be relayed verbatim.
 *
 * `/api/chat` is public and unauthenticated. When a model account runs out
 * of credit the route answered anonymous callers with the provider's own billing
 * string — "Your credit balance is too low… go to Plans & Billing" — which is an
 * operator problem told to the wrong audience, and tells a stranger which
 * provider is behind the endpoint and what state the account is in.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeProviderError } from "../src/chat/agent.js";

describe("sanitizeProviderError", () => {
  it("does not relay a provider billing message", () => {
    const raw = "You exceeded your current quota. Please check your plan and billing details.";
    const out = sanitizeProviderError(raw);
    expect(out).not.toMatch(/quota/i);
    expect(out).not.toMatch(/billing/i);
    expect(out).toMatch(/temporarily unavailable/i);
  });

  it("does not relay an API key or auth detail", () => {
    const out = sanitizeProviderError("401 invalid Authorization bearer sk-SECRET");
    expect(out).not.toMatch(/sk-SECRET/);
    expect(out).not.toMatch(/Authorization/i);
  });

  it("keeps a rate-limit signal, which is useful and discloses nothing", () => {
    expect(sanitizeProviderError("429 rate_limit_error: too many requests")).toMatch(
      /rate limit|busy/i,
    );
  });

  it("says the other surfaces still work, because they do", () => {
    expect(sanitizeProviderError("boom")).toMatch(/every other view|other surfaces|unaffected/i);
  });
});

describe("chat timeout budget", () => {
  it("fits inside the Lambda timeout so the abort can actually fire", async () => {
    const { loadConfig } = await import("../src/config.js");
    // Read the real CDK source rather than copying the number: a hand-mirrored
    // constant is how this invariant silently goes stale when the stack moves.
    const stack = readFileSync(
      new URL("../../../infra/lake-runtime-stack.ts", import.meta.url),
      "utf8",
    );
    const declared = /timeout:\s*Duration\.seconds\((\d+)\)/.exec(stack);
    expect(declared, "could not find the Lambda timeout in the CDK stack").not.toBeNull();
    const lambdaTimeoutMs = Number(declared![1]) * 1000;
    // A Function URL in BUFFERED invoke mode kills the request at 60 s however
    // long the function itself may run, so the Lambda timeout is not on its own
    // a sufficient bound. Assert against whichever ceiling is actually lower,
    // or the abort silently becomes unreachable again.
    const BUFFERED_FUNCTION_URL_LIMIT_MS = 60_000;
    const bufferedMode = !/invokeMode:\s*InvokeMode\.RESPONSE_STREAM/.test(stack);
    const wall = bufferedMode
      ? Math.min(lambdaTimeoutMs, BUFFERED_FUNCTION_URL_LIMIT_MS)
      : lambdaTimeoutMs;
    expect(loadConfig({}).chatTimeoutMs).toBeLessThan(wall);
  });
});
