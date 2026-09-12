import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handlePagerDutyNotification,
  resetPagerDutyNotificationState,
} from "../src/observability/pagerduty-notifier.js";
import {
  PAGERDUTY_PRODUCTION_ACCOUNT,
  PAGERDUTY_PRODUCTION_REGION,
} from "../src/observability/pagerduty.js";

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-2:122610508924:secret:oracle-lake/pagerduty-ABC123";

function environment(fetchImpl = vi.fn()) {
  return {
    environment: "production",
    accountId: PAGERDUTY_PRODUCTION_ACCOUNT,
    region: PAGERDUTY_PRODUCTION_REGION,
    secretArn: SECRET_ARN,
    secretsClient: {
      send: vi.fn().mockResolvedValue({
        SecretString: '{"routing_key":"routing-key-value"}',
      }),
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

function accepted(dedupKey: string): Response {
  return new Response(JSON.stringify({ status: "success", dedup_key: dedupKey }), {
    status: 202,
  });
}

afterEach(() => resetPagerDutyNotificationState());

describe("PagerDuty notifier handler", () => {
  it("validates and forwards one bounded direct terminal-failure event", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted("pd-direct"));
    const receipt = await handlePagerDutyNotification(
      {
        summary: "Lake ingestion exhausted its retry budget",
        source: "clermont-cli",
        dedupKey: "clermont-acquisition/run-001/FAILED_EXHAUSTED",
        customDetails: {
          runId: "run-001",
          token: "must-not-leave-the-process",
          errorMessage: "x".repeat(2_000),
        },
      },
      environment(fetchImpl),
    );

    expect(receipt).toEqual({ status: "triggered", dedupKey: "pd-direct" });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      event_action: string;
      payload: { custom_details: Record<string, unknown> };
    };
    expect(request.event_action).toBe("trigger");
    expect(request.payload.custom_details).not.toHaveProperty("token");
    expect(String(request.payload.custom_details.errorMessage)).toHaveLength(512);
  });

  it("unwraps a workflow terminal-failure event delivered through SNS", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted("pd-workflow"));
    const receipt = await handlePagerDutyNotification(
      {
        Records: [
          {
            Sns: {
              Message: JSON.stringify({
                summary: "Scheduled Lake ingestion failed",
                source: "github-actions/oracle-lake-pipeline",
                dedupKey: "github-actions/oracle-lake-pipeline/failure",
                customDetails: { runId: "run-001", stage: "candidate-build" },
              }),
            },
          },
        ],
      },
      environment(fetchImpl),
    );

    expect(receipt).toEqual({ status: "triggered", dedupKey: "pd-workflow" });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      event_action: string;
      dedup_key: string;
    };
    expect(request.event_action).toBe("trigger");
    expect(request.dedup_key).toBe("github-actions/oracle-lake-pipeline/failure");
  });

  it.each([
    ["ALARM", "trigger"],
    ["OK", "resolve"],
  ] as const)("maps a CloudWatch %s transition to PagerDuty %s", async (state, action) => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted(`pd-${action}`));
    const receipt = await handlePagerDutyNotification(
      {
        Records: [
          {
            Sns: {
              Message: JSON.stringify({
                AlarmName: "OracleLake-runtime-errors",
                NewStateValue: state,
                NewStateReason: "threshold crossed",
                StateChangeTime: "2026-09-12T00:00:00.000Z",
                Region: "US East (Ohio)",
              }),
            },
          },
        ],
      },
      environment(fetchImpl),
    );

    expect(receipt).toEqual({
      status: action === "trigger" ? "triggered" : "resolved",
      dedupKey: `pd-${action}`,
    });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      event_action: string;
      dedup_key: string;
    };
    expect(request.event_action).toBe(action);
    expect(request.dedup_key).toBe("cloudwatch-alarm/OracleLake-runtime-errors");
  });

  it("fails malformed alarm events before reading a secret or calling PagerDuty", async () => {
    const env = environment();
    await expect(
      handlePagerDutyNotification(
        { Records: [{ Sns: { Message: '{"AlarmName":"runtime"}' } }] },
        env,
      ),
    ).rejects.toThrow(/CloudWatch alarm/);
    expect(env.secretsClient.send).not.toHaveBeenCalled();
    expect(env.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed PagerDuty 202 receipt", async () => {
    await expect(
      handlePagerDutyNotification(
        {
          summary: "terminal",
          source: "test",
          dedupKey: "run/test",
        },
        environment(vi.fn().mockResolvedValue(new Response("{}", { status: 202 }))),
      ),
    ).rejects.toThrow(/dedup_key/);
  });
});
