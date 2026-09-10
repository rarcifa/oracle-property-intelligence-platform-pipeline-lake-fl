/**
 * A service that can fail critically but cannot page on-call is an incomplete
 * service, and swallowing a critical failure with a log-only handler is
 * forbidden. These tests pin the contract the guidelines specify: routing key
 * from Secrets Manager, production-gated, Events API v2, 202 means accepted,
 * and the routing key never leaves the request body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAGERDUTY_EVENTS_URL,
  resetPagerDutyRoutingKey,
  triggerPagerDutyAlert,
} from "../src/observability/pagerduty.js";

const alert = {
  summary: "Lake County runtime cannot open the published dataset",
  source: "oracle-lake-runtime",
  severity: "critical" as const,
  dedupKey: "oracle-lake-runtime/dataset-unavailable/fn",
  customDetails: { path: "/api/health" },
};

const accepted = (): Response =>
  new Response(JSON.stringify({ dedup_key: "pd-123", status: "success" }), { status: 202 });

function secrets(value: string | undefined) {
  return { send: vi.fn().mockResolvedValue({ SecretString: value }) };
}

afterEach(() => {
  resetPagerDutyRoutingKey();
});

describe("triggerPagerDutyAlert", () => {
  it("pages through Events API v2 and returns the dedup key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      secretId: "oracle-lake/pagerduty",
      secretsClient: secrets("routing-key-value"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "triggered", dedupKey: "pd-123" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PAGERDUTY_EVENTS_URL);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.event_action).toBe("trigger");
    expect(body.routing_key).toBe("routing-key-value");
    expect(body.dedup_key).toBe(alert.dedupKey);
    expect((body.payload as { severity: string }).severity).toBe("critical");
  });

  it("reads the routing key once per container", async () => {
    const secretsClient = secrets("routing-key-value");
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    const env = {
      environment: "production",
      secretId: "oracle-lake/pagerduty",
      secretsClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    await triggerPagerDutyAlert(alert, env);
    await triggerPagerDutyAlert(alert, env);
    expect(secretsClient.send).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not page outside production, whatever else is configured", async () => {
    const fetchImpl = vi.fn();
    for (const environment of ["staging", "", undefined]) {
      const result = await triggerPagerDutyAlert(alert, {
        environment,
        secretId: "oracle-lake/pagerduty",
        secretsClient: secrets("routing-key-value"),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.status).toBe("skipped");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says plainly when no routing key is configured, rather than claiming success", async () => {
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      secretId: "",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result).toEqual({
      status: "skipped",
      reason: "no PagerDuty routing key is configured",
    });
  });

  it("treats anything but 202 as nobody having been told", async () => {
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      secretId: "oracle-lake/pagerduty",
      secretsClient: secrets("routing-key-value"),
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response("no", { status: 400 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "failed", reason: "PagerDuty returned HTTP 400" });
  });

  it("never throws, so the caller can still rethrow the original failure", async () => {
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      secretId: "oracle-lake/pagerduty",
      secretsClient: { send: vi.fn().mockRejectedValue(new Error("AccessDenied")) },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "failed", reason: "AccessDenied" });
  });
});
