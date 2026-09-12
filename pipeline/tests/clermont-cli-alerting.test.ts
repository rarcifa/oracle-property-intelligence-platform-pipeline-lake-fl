import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  armClermontTerminalNotification,
  assertExactClermontFailureTopicArn,
  assertSupportedNodeRuntime,
  clermontFailureTopicAwsCliArguments,
  clermontNotifierAwsCliArguments,
  deliverClermontTerminalNotification,
  invokeClermontFailureTopic,
  invokeClermontFailureNotifier,
  loadClermontTerminalNotification,
  runWithFailedExhaustedPaging,
  selectClermontFailureTransport,
} from "../bin/clermont-ingestion.js";

const NOTIFIER_ARN =
  "arn:aws:lambda:us-east-2:122610508924:function:ClermontBaseline-FailureNotifier";
const TOPIC_ARN = "arn:aws:sns:us-east-2:122610508924:ClermontBaselineStack-BaselineAlertTopic";
const scratchRoots: string[] = [];

async function freshRunStore(): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), "clermont-cli-alerting-"));
  scratchRoots.push(scratch);
  return scratch;
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((scratch) => rm(scratch, { recursive: true })));
});

describe("Clermont CLI terminal alerting", () => {
  it("pages once for a durable FAILED_EXHAUSTED state and rethrows the original error", async () => {
    const original = new Error("retry budget exhausted");
    const runId = "run-0001";
    const runStore = await freshRunStore();
    const invoke = vi.fn().mockResolvedValue({
      status: "triggered",
      dedupKey: `clermont-acquisition/${runId}/FAILED_EXHAUSTED`,
    });
    const operation = vi.fn().mockRejectedValue(original);

    let observed: unknown;
    try {
      await runWithFailedExhaustedPaging({
        operation,
        loadCoordinator: vi
          .fn()
          .mockResolvedValueOnce({ runId, revision: 8, state: "RUNNING" })
          .mockResolvedValueOnce({ runId, revision: 9, state: "FAILED_EXHAUSTED" }),
        invokeNotifier: invoke,
        notifierArn: NOTIFIER_ARN,
        transportKind: "pagerduty",
        runStore,
        runId,
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(original);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      NOTIFIER_ARN,
      expect.objectContaining({
        dedupKey: `clermont-acquisition/${runId}/FAILED_EXHAUSTED`,
        customDetails: { runId, state: "FAILED_EXHAUSTED" },
      }),
    );
  });

  it.each(["READY", "RUNNING", "WAITING_HUMAN", "COMPLETE"] as const)(
    "does not page a %s failure path",
    async (state) => {
      const runId = "run-0002";
      const invoke = vi.fn();
      const original = new Error(`recoverable ${state}`);
      await expect(
        runWithFailedExhaustedPaging({
          operation: vi.fn().mockRejectedValue(original),
          loadCoordinator: vi.fn().mockResolvedValue({
            runId,
            revision: 4,
            state,
          }),
          invokeNotifier: invoke,
          notifierArn: NOTIFIER_ARN,
          transportKind: "pagerduty",
          runStore: await freshRunStore(),
          runId,
        }),
      ).rejects.toBe(original);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("preserves the acquisition error when paging itself fails", async () => {
    const original = new Error("terminal acquisition failure");
    const runId = "run-0003";
    const runStore = await freshRunStore();
    const invoke = vi.fn().mockRejectedValue(new Error("notifier unavailable"));
    await expect(
      runWithFailedExhaustedPaging({
        operation: vi.fn().mockRejectedValue(original),
        loadCoordinator: vi
          .fn()
          .mockResolvedValueOnce({ runId, revision: 3, state: "RUNNING" })
          .mockResolvedValueOnce({ runId, revision: 4, state: "FAILED_EXHAUSTED" }),
        invokeNotifier: invoke,
        notifierArn: NOTIFIER_ARN,
        transportKind: "pagerduty",
        runStore,
        runId,
        reportNotificationFailure: vi.fn(),
        retryDelaysMs: [0, 0],
      }),
    ).rejects.toBe(original);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(await loadClermontTerminalNotification(runStore, runId)).toMatchObject({
      status: "pending",
      attempts: 3,
    });

    invoke.mockResolvedValue({
      status: "triggered",
      dedupKey: `clermont-acquisition/${runId}/FAILED_EXHAUSTED`,
    });
    const retryError = new Error("authorization expired while resuming terminal run");
    await expect(
      runWithFailedExhaustedPaging({
        operation: vi.fn().mockRejectedValue(retryError),
        loadCoordinator: vi.fn().mockResolvedValue({
          runId,
          revision: 4,
          state: "FAILED_EXHAUSTED",
        }),
        invokeNotifier: invoke,
        notifierArn: NOTIFIER_ARN,
        transportKind: "pagerduty",
        runStore,
        runId,
        reportNotificationFailure: vi.fn(),
        retryDelaysMs: [0, 0],
      }),
    ).rejects.toBe(retryError);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(await loadClermontTerminalNotification(runStore, runId)).toMatchObject({
      status: "delivered",
      attempts: 4,
      receiptId: `clermont-acquisition/${runId}/FAILED_EXHAUSTED`,
    });
  });

  it("fails closed before acquisition when coordinator state cannot be loaded and armed", async () => {
    const prestateError = new Error("coordinator was never prepared");
    const operation = vi.fn();
    const invoke = vi.fn();
    await expect(
      runWithFailedExhaustedPaging({
        operation,
        loadCoordinator: vi.fn().mockRejectedValue(prestateError),
        invokeNotifier: invoke,
        notifierArn: NOTIFIER_ARN,
        transportKind: "pagerduty",
        runStore: await freshRunStore(),
        runId: "run-early-rejection",
        reportNotificationFailure: vi.fn(),
      }),
    ).rejects.toBe(prestateError);
    expect(operation).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not notify again when a previously exhausted run fails an auth or cost check", async () => {
    const runStore = await freshRunStore();
    const invoke = vi.fn();
    const loadCoordinator = vi.fn().mockResolvedValue({
      runId: "run-stale-terminal",
      revision: 17,
      state: "FAILED_EXHAUSTED" as const,
    });

    for (const message of ["authorization expired", "cost ceiling exceeded"]) {
      const original = new Error(message);
      await expect(
        runWithFailedExhaustedPaging({
          operation: vi.fn().mockRejectedValue(original),
          loadCoordinator,
          invokeNotifier: invoke,
          notifierArn: TOPIC_ARN,
          transportKind: "sns-email",
          runStore,
          runId: "run-stale-terminal",
        }),
      ).rejects.toBe(original);
    }

    expect(invoke).not.toHaveBeenCalled();
  });

  it("recovers a pre-armed notification after a crash immediately following terminal state", async () => {
    const runId = "run-crash-window";
    const runStore = await freshRunStore();
    await armClermontTerminalNotification({
      runStore,
      runId,
      coordinator: { runId, revision: 40, state: "RUNNING" },
      transportKind: "sns-email",
      targetArn: TOPIC_ARN,
    });
    await expect(
      armClermontTerminalNotification({
        runStore,
        runId,
        coordinator: { runId, revision: 39, state: "RUNNING" },
        transportKind: "sns-email",
        targetArn: TOPIC_ARN,
      }),
    ).rejects.toThrow(/cannot regress/);

    const invoke = vi.fn().mockResolvedValue({
      status: "triggered",
      dedupKey: `clermont-acquisition/${runId}/FAILED_EXHAUSTED`,
      receiptId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
    const original = new Error("authorization expired after terminal crash recovery");
    await expect(
      runWithFailedExhaustedPaging({
        operation: vi.fn().mockRejectedValue(original),
        loadCoordinator: vi.fn().mockResolvedValue({
          runId,
          revision: 41,
          state: "FAILED_EXHAUSTED",
        }),
        invokeNotifier: invoke,
        notifierArn: TOPIC_ARN,
        transportKind: "sns-email",
        runStore,
        runId,
      }),
    ).rejects.toBe(original);

    expect(invoke).toHaveBeenCalledOnce();
    expect(await loadClermontTerminalNotification(runStore, runId)).toMatchObject({
      status: "delivered",
      coordinatorRevision: 41,
      attempts: 1,
      receiptId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
  });

  it("rejects an unbounded terminal transport retry schedule before calling the transport", async () => {
    const invoke = vi.fn();
    await expect(
      deliverClermontTerminalNotification({
        runStore: await freshRunStore(),
        runId: "run-bounded-retry",
        coordinatorBefore: { runId: "run-bounded-retry", revision: 1, state: "RUNNING" },
        coordinatorAfter: {
          runId: "run-bounded-retry",
          revision: 2,
          state: "FAILED_EXHAUSTED",
        },
        transportKind: "sns-email",
        targetArn: TOPIC_ARN,
        invokeNotifier: invoke,
        retryDelaysMs: [0, 0, 0, 0, 0, 0],
      }),
    ).rejects.toThrow(/at most five retry delays/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("binds pending and delivered notification state to the exact terminal coordinator revision", async () => {
    const runId = "run-revision-bound";
    const runStore = await freshRunStore();
    const invoke = vi.fn().mockResolvedValue({
      status: "triggered",
      dedupKey: `clermont-acquisition/${runId}/FAILED_EXHAUSTED`,
    });
    await deliverClermontTerminalNotification({
      runStore,
      runId,
      coordinatorBefore: { runId, revision: 20, state: "RUNNING" },
      coordinatorAfter: { runId, revision: 21, state: "FAILED_EXHAUSTED" },
      transportKind: "pagerduty",
      targetArn: NOTIFIER_ARN,
      invokeNotifier: invoke,
    });

    await expect(
      deliverClermontTerminalNotification({
        runStore,
        runId,
        coordinatorBefore: { runId, revision: 21, state: "FAILED_EXHAUSTED" },
        coordinatorAfter: { runId, revision: 22, state: "FAILED_EXHAUSTED" },
        transportKind: "pagerduty",
        targetArn: NOTIFIER_ARN,
        invokeNotifier: invoke,
      }),
    ).rejects.toThrow(/revision does not match/);
    await expect(
      deliverClermontTerminalNotification({
        runStore,
        runId,
        coordinatorBefore: { runId, revision: 21, state: "FAILED_EXHAUSTED" },
        coordinatorAfter: { runId, revision: 21, state: "COMPLETE" },
        transportKind: "pagerduty",
        targetArn: NOTIFIER_ARN,
        invokeNotifier: invoke,
      }),
    ).rejects.toThrow(/requires a FAILED_EXHAUSTED coordinator/);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects corrupted delivered SNS evidence before suppressing the transport", async () => {
    const runId = "run-corrupt-receipt";
    const runStore = await freshRunStore();
    const invoke = vi.fn().mockResolvedValue({
      status: "triggered",
      dedupKey: `clermont-acquisition/${runId}/FAILED_EXHAUSTED`,
      receiptId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
    const context = {
      runStore,
      runId,
      coordinatorBefore: { runId, revision: 30, state: "RUNNING" as const },
      coordinatorAfter: { runId, revision: 31, state: "FAILED_EXHAUSTED" as const },
      transportKind: "sns-email" as const,
      targetArn: TOPIC_ARN,
      invokeNotifier: invoke,
    };
    await deliverClermontTerminalNotification(context);
    const delivered = await loadClermontTerminalNotification(runStore, runId);
    if (delivered === null) throw new Error("expected a durable delivered notification");
    const receiptPath = path.join(runStore, "runs", runId, "terminal-notification.json");

    await writeFile(receiptPath, `${JSON.stringify({ ...delivered, receiptId: "not-a-uuid" })}\n`);
    await expect(
      deliverClermontTerminalNotification({
        ...context,
        coordinatorBefore: { runId, revision: 31, state: "FAILED_EXHAUSTED" },
      }),
    ).rejects.toThrow(/UUID MessageId/);

    await writeFile(receiptPath, `${JSON.stringify({ ...delivered, attempts: 0 })}\n`);
    await expect(
      deliverClermontTerminalNotification({
        ...context,
        coordinatorBefore: { runId, revision: 31, state: "FAILED_EXHAUSTED" },
      }),
    ).rejects.toThrow(/consistent durable delivery evidence/);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("notifies once across a terminal transition and a repeated invocation", async () => {
    const runStore = await freshRunStore();
    const invoke = vi.fn().mockResolvedValue({
      status: "triggered",
      dedupKey: "clermont-acquisition/run-transition/FAILED_EXHAUSTED",
      receiptId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
    const snapshots = [
      { runId: "run-transition", revision: 10, state: "RUNNING" as const },
      { runId: "run-transition", revision: 11, state: "FAILED_EXHAUSTED" as const },
      { runId: "run-transition", revision: 11, state: "FAILED_EXHAUSTED" as const },
      { runId: "run-transition", revision: 11, state: "FAILED_EXHAUSTED" as const },
    ];
    const loadCoordinator = vi.fn().mockImplementation(async () => snapshots.shift()!);

    for (const message of ["retry budget exhausted", "authorization expired on retry"]) {
      await expect(
        runWithFailedExhaustedPaging({
          operation: vi.fn().mockRejectedValue(new Error(message)),
          loadCoordinator,
          invokeNotifier: invoke,
          notifierArn: TOPIC_ARN,
          transportKind: "sns-email",
          runStore,
          runId: "run-transition",
        }),
      ).rejects.toThrow(message);
    }

    expect(invoke).toHaveBeenCalledOnce();
    expect(await loadClermontTerminalNotification(runStore, "run-transition")).toMatchObject({
      status: "delivered",
      attempts: 1,
      receiptId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
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

  it("requires exactly one validated terminal failure transport", () => {
    expect(() => selectClermontFailureTransport({})).toThrow(/Exactly one/);
    expect(() =>
      selectClermontFailureTransport({ notifierArn: NOTIFIER_ARN, topicArn: TOPIC_ARN }),
    ).toThrow(/Exactly one/);
    expect(selectClermontFailureTransport({ notifierArn: NOTIFIER_ARN })).toEqual({
      kind: "pagerduty",
      targetArn: NOTIFIER_ARN,
    });
    expect(selectClermontFailureTransport({ topicArn: TOPIC_ARN })).toEqual({
      kind: "sns-email",
      targetArn: TOPIC_ARN,
    });
  });

  it("rejects SNS topics outside the exact production account and region", () => {
    for (const arn of [
      "BaselineAlertTopic",
      "arn:aws:sns:us-east-1:122610508924:BaselineAlertTopic",
      "arn:aws:sns:us-east-2:000000000000:BaselineAlertTopic",
      "arn:aws:lambda:us-east-2:122610508924:function:BaselineAlertTopic",
    ]) {
      expect(() => assertExactClermontFailureTopicArn(arn)).toThrow(/exact production SNS ARN/);
    }
  });

  it("publishes the same bounded terminal event to the approved SNS topic in us-east-2", () => {
    const event = {
      summary: "terminal",
      source: "test",
      dedupKey: "clermont-acquisition/run-001/FAILED_EXHAUSTED",
      customDetails: { runId: "run-001", state: "FAILED_EXHAUSTED" as const },
    };
    expect(clermontFailureTopicAwsCliArguments(TOPIC_ARN, event)).toEqual([
      "sns",
      "publish",
      "--region",
      "us-east-2",
      "--topic-arn",
      TOPIC_ARN,
      "--subject",
      "Clermont acquisition failed",
      "--message",
      JSON.stringify(event),
      "--output",
      "json",
    ]);
  });

  it("accepts only a valid SNS MessageId and preserves the stable run dedup key", async () => {
    const event = {
      summary: "terminal",
      source: "test",
      dedupKey: "clermont-acquisition/run-001/FAILED_EXHAUSTED",
      customDetails: { runId: "run-001", state: "FAILED_EXHAUSTED" as const },
    };
    const publish = vi.fn().mockResolvedValue({
      MessageId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
    await expect(invokeClermontFailureTopic(TOPIC_ARN, event, publish)).resolves.toEqual({
      status: "triggered",
      dedupKey: event.dedupKey,
      receiptId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
    expect(publish).toHaveBeenCalledOnce();

    publish.mockResolvedValueOnce({ MessageId: "not-a-message-id" });
    await expect(invokeClermontFailureTopic(TOPIC_ARN, event, publish)).rejects.toThrow(
      /invalid publish receipt/,
    );
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
