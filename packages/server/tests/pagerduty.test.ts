/**
 * A service that can fail critically but cannot page on-call is an incomplete
 * service, and swallowing a critical failure with a log-only handler is
 * forbidden. These tests pin the contract the guidelines specify: routing key
 * from Secrets Manager, production-gated, Events API v2, 202 means accepted,
 * and the routing key never leaves the request body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAGERDUTY_PRODUCTION_ACCOUNT,
  PAGERDUTY_PRODUCTION_REGION,
  PAGERDUTY_EVENTS_URL,
  cloudWatchAlarmDedupKey,
  DATASET_UNAVAILABLE_ALARM_NAME,
  resetPagerDutyRoutingKey,
  triggerPagerDutyAlert,
} from "../src/observability/pagerduty.js";

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-2:122610508924:secret:oracle-lake/pagerduty-ABC123";

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
  it("shares the dataset-unavailable incident key with its self-resolving alarm", () => {
    expect(cloudWatchAlarmDedupKey(DATASET_UNAVAILABLE_ALARM_NAME)).toBe(
      "cloudwatch-alarm/OracleLake-dataset-unavailable",
    );
  });
  it("pages through Events API v2 and returns the dedup key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
      region: PAGERDUTY_PRODUCTION_REGION,
      secretArn: SECRET_ARN,
      secretsClient: secrets('{"routing_key":"routing-key-value"}'),
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

  it("bounds details and strips credential-bearing keys at the transport boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    await triggerPagerDutyAlert(
      {
        ...alert,
        summary: "s".repeat(1_000),
        customDetails: {
          error: "x".repeat(2_000),
          nested: { authorization: "must-not-leave", safe: "visible" },
        },
      },
      {
        environment: "production",
        accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
        region: PAGERDUTY_PRODUCTION_REGION,
        secretArn: SECRET_ARN,
        secretsClient: secrets('{"routing_key":"routing-key-value"}'),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      payload: { summary: string; custom_details: Record<string, unknown> };
    };
    expect(request.payload.summary).toHaveLength(256);
    expect(request.payload.custom_details.error).toHaveLength(512);
    expect(request.payload.custom_details.nested).toEqual({ safe: "visible" });
  });

  it("reads the routing key once per container", async () => {
    const secretsClient = secrets("routing-key-value");
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    const env = {
      environment: "production",
      accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
      region: PAGERDUTY_PRODUCTION_REGION,
      secretArn: SECRET_ARN,
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
        accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
        region: PAGERDUTY_PRODUCTION_REGION,
        secretArn: SECRET_ARN,
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
      accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
      region: PAGERDUTY_PRODUCTION_REGION,
      secretArn: "",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result).toEqual({
      status: "failed",
      reason: "PagerDuty requires one exact production Secrets Manager ARN",
    });
  });

  it("treats anything but 202 as nobody having been told", async () => {
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
      region: PAGERDUTY_PRODUCTION_REGION,
      secretArn: SECRET_ARN,
      secretsClient: secrets('{"routing_key":"routing-key-value"}'),
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response("no", { status: 400 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "failed", reason: "PagerDuty returned HTTP 400" });
  });

  it("never throws, so the caller can still rethrow the original failure", async () => {
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
      region: PAGERDUTY_PRODUCTION_REGION,
      secretArn: SECRET_ARN,
      secretsClient: { send: vi.fn().mockRejectedValue(new Error("AccessDenied")) },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "failed", reason: "AccessDenied" });
  });

  it("fails closed for JSON secrets that omit routing_key", async () => {
    const fetchImpl = vi.fn();
    const result = await triggerPagerDutyAlert(alert, {
      environment: "production",
      accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
      region: PAGERDUTY_PRODUCTION_REGION,
      secretArn: SECRET_ARN,
      secretsClient: secrets('{"service":"lake"}'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({
      status: "failed",
      reason: "PagerDuty JSON secret must contain a non-empty routing_key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed 202 receipts instead of assuming the request was accepted", async () => {
    for (const response of [
      new Response("not-json", { status: 202 }),
      new Response(JSON.stringify({ status: "success" }), { status: 202 }),
      new Response(JSON.stringify({ dedup_key: "" }), { status: 202 }),
    ]) {
      resetPagerDutyRoutingKey();
      const result = await triggerPagerDutyAlert(alert, {
        environment: "production",
        accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
        region: PAGERDUTY_PRODUCTION_REGION,
        secretArn: SECRET_ARN,
        secretsClient: secrets('{"routing_key":"routing-key-value"}'),
        fetchImpl: vi.fn().mockResolvedValue(response) as unknown as typeof fetch,
      });
      expect(result.status).toBe("failed");
    }
  });

  it("never pages from the wrong account or region", async () => {
    const fetchImpl = vi.fn();
    for (const target of [
      { accountId: "000000000000", region: PAGERDUTY_PRODUCTION_REGION },
      { accountId: PAGERDUTY_PRODUCTION_ACCOUNT, region: "us-east-1" },
    ]) {
      const result = await triggerPagerDutyAlert(alert, {
        environment: "production",
        ...target,
        secretArn: SECRET_ARN,
        secretsClient: secrets('{"routing_key":"routing-key-value"}'),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.status).toBe("skipped");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
