import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertSupportedNodeRuntime,
  clermontNotifierAwsCliArguments,
  invokeClermontFailureNotifier,
  runWithFailedExhaustedPaging,
} from "../bin/clermont-ingestion.js";

const NOTIFIER_ARN =
  "arn:aws:lambda:us-east-2:122610508924:function:ClermontBaseline-FailureNotifier";

describe("Clermont CLI terminal alerting", () => {
  it("pages once for a durable FAILED_EXHAUSTED state and rethrows the original error", async () => {
    const original = new Error("retry budget exhausted");
    const invoke = vi.fn().mockResolvedValue({ status: "triggered", dedupKey: "pd-001" });
    const operation = vi.fn().mockRejectedValue(original);

    let observed: unknown;
    try {
      await runWithFailedExhaustedPaging({
        operation,
        loadState: vi.fn().mockResolvedValue("FAILED_EXHAUSTED"),
        invokeNotifier: invoke,
        notifierArn: NOTIFIER_ARN,
        runId: "run-001",
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(original);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      NOTIFIER_ARN,
      expect.objectContaining({
        dedupKey: "clermont-acquisition/run-001/FAILED_EXHAUSTED",
        customDetails: { runId: "run-001", state: "FAILED_EXHAUSTED" },
      }),
    );
  });

  it.each(["READY", "RUNNING", "WAITING_HUMAN", "COMPLETE"] as const)(
    "does not page a %s failure path",
    async (state) => {
      const invoke = vi.fn();
      const original = new Error(`recoverable ${state}`);
      await expect(
        runWithFailedExhaustedPaging({
          operation: vi.fn().mockRejectedValue(original),
          loadState: vi.fn().mockResolvedValue(state),
          invokeNotifier: invoke,
          notifierArn: NOTIFIER_ARN,
          runId: "run-002",
        }),
      ).rejects.toBe(original);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("preserves the acquisition error when paging itself fails", async () => {
    const original = new Error("terminal acquisition failure");
    await expect(
      runWithFailedExhaustedPaging({
        operation: vi.fn().mockRejectedValue(original),
        loadState: vi.fn().mockResolvedValue("FAILED_EXHAUSTED"),
        invokeNotifier: vi.fn().mockRejectedValue(new Error("notifier unavailable")),
        notifierArn: NOTIFIER_ARN,
        runId: "run-003",
        reportNotificationFailure: vi.fn(),
      }),
    ).rejects.toBe(original);
  });

  it("does not page an auth or cost failure that has no durable terminal state", async () => {
    const original = new Error("authorization rejected before acquisition");
    const invoke = vi.fn();
    await expect(
      runWithFailedExhaustedPaging({
        operation: vi.fn().mockRejectedValue(original),
        loadState: vi.fn().mockRejectedValue(new Error("coordinator was never prepared")),
        invokeNotifier: invoke,
        notifierArn: NOTIFIER_ARN,
        runId: "run-early-rejection",
        reportNotificationFailure: vi.fn(),
      }),
    ).rejects.toBe(original);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects non-exact notifier ARNs before invoking AWS", async () => {
    const execute = vi.fn();
    for (const arn of [
      "FailureNotifier",
      "arn:aws:lambda:us-east-1:122610508924:function:FailureNotifier",
      "arn:aws:lambda:us-east-2:000000000000:function:FailureNotifier",
      `${NOTIFIER_ARN}:alias`,
    ]) {
      await expect(
        invokeClermontFailureNotifier(
          arn,
          {
            summary: "terminal",
            source: "test",
            dedupKey: "run/test",
            customDetails: { runId: "test", state: "FAILED_EXHAUSTED" },
          },
          execute,
        ),
      ).rejects.toThrow(/exact production Lambda ARN/);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("invokes the production notifier in us-east-2 regardless of the operator profile default", () => {
    const event = {
      summary: "terminal",
      source: "test",
      dedupKey: "run/test",
      customDetails: { runId: "test", state: "FAILED_EXHAUSTED" as const },
    };
    expect(clermontNotifierAwsCliArguments(NOTIFIER_ARN, event, "/tmp/receipt.json")).toEqual([
      "lambda",
      "invoke",
      "--region",
      "us-east-2",
      "--function-name",
      NOTIFIER_ARN,
      "--cli-binary-format",
      "raw-in-base64-out",
      "--payload",
      JSON.stringify(event),
      "/tmp/receipt.json",
    ]);
  });

  it("accepts only a well-formed Lambda receipt with a returned PagerDuty dedup key", async () => {
    const execute = vi.fn().mockResolvedValue({
      invocation: { StatusCode: 200 },
      payload: { status: "triggered", dedupKey: "pd-returned" },
    });
    await expect(
      invokeClermontFailureNotifier(
        NOTIFIER_ARN,
        {
          summary: "terminal",
          source: "test",
          dedupKey: "run/test",
          customDetails: { runId: "test", state: "FAILED_EXHAUSTED" },
        },
        execute,
      ),
    ).resolves.toEqual({ status: "triggered", dedupKey: "pd-returned" });

    execute.mockResolvedValueOnce({
      invocation: { StatusCode: 200 },
      payload: { status: "triggered" },
    });
    await expect(
      invokeClermontFailureNotifier(
        NOTIFIER_ARN,
        {
          summary: "terminal",
          source: "test",
          dedupKey: "run/test",
          customDetails: { runId: "test", state: "FAILED_EXHAUSTED" },
        },
        execute,
      ),
    ).rejects.toThrow(/receipt/);
  });

  it("rejects Node versions outside the supported 22.18+ release line", () => {
    expect(() => assertSupportedNodeRuntime("22.18.0")).not.toThrow();
    expect(() => assertSupportedNodeRuntime("22.99.1")).not.toThrow();
    expect(() => assertSupportedNodeRuntime("22.17.9")).toThrow(/Node 22\.18/);
    expect(() => assertSupportedNodeRuntime("23.0.0")).toThrow(/Node 22\.18/);
  });

  it("pins both executable package contracts below Node 23", async () => {
    const pipelinePackage = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { engines: { node: string } };
    const rootPackage = JSON.parse(
      await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { engines: { node: string } };
    expect(pipelinePackage.engines.node).toBe(">=22.18.0 <23");
    expect(rootPackage.engines.node).toBe(">=22.18.0 <23");
  });
});
