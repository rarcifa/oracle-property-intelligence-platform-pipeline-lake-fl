/**
 * The agent's upstream failures must not be relayed verbatim.
 *
 * `/api/chat` is public and unauthenticated. When the Anthropic account ran out
 * of credit the route answered anonymous callers with the provider's own billing
 * string — "Your credit balance is too low… go to Plans & Billing" — which is an
 * operator problem told to the wrong audience, and tells a stranger which
 * provider is behind the endpoint and what state the account is in.
 */
import { describe, expect, it } from "vitest";
import { sanitizeProviderError } from "../src/chat/agent.js";

describe("sanitizeProviderError", () => {
  it("does not relay a provider billing message", () => {
    const raw =
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    const out = sanitizeProviderError(raw);
    expect(out).not.toMatch(/credit balance/i);
    expect(out).not.toMatch(/Plans & Billing/i);
    expect(out).toMatch(/temporarily unavailable/i);
  });

  it("does not relay an API key or auth detail", () => {
    const out = sanitizeProviderError("401 invalid x-api-key sk-ant-api03-SECRET");
    expect(out).not.toMatch(/sk-ant/);
    expect(out).not.toMatch(/x-api-key/i);
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
    // infra/lake-runtime-stack.ts sets Duration.seconds(60).
    const LAMBDA_TIMEOUT_MS = 60_000;
    expect(loadConfig({}).chatTimeoutMs).toBeLessThan(LAMBDA_TIMEOUT_MS);
  });
});
