import { beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({
  addMetric: vi.fn(),
  publish: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@aws-lambda-powertools/logger", () => ({
  Logger: class {
    info = telemetry.info;
    warn = telemetry.warn;
    error = telemetry.error;
  },
}));

vi.mock("@aws-lambda-powertools/metrics", () => ({
  MetricUnit: { Count: "Count", Milliseconds: "Milliseconds" },
  Metrics: class {
    addMetric = telemetry.addMetric;
    publishStoredMetrics = telemetry.publish;
  },
}));

vi.mock("@aws-lambda-powertools/tracer", () => ({
  Tracer: class {},
}));

vi.stubGlobal("awslambda", {
  streamifyResponse: vi.fn((handler: unknown) => handler),
  HttpResponseStream: { from: vi.fn() },
});

const { observePointerRefresh } = await import("../src/lambda.js");

type RefreshTarget = Parameters<typeof observePointerRefresh>[0];

beforeEach(() => vi.clearAllMocks());

describe("background pointer refresh observability", () => {
  it("flushes a successful upgrade in its own metric buffer", async () => {
    const current = {
      refresh: vi.fn().mockResolvedValue({
        status: "upgraded",
        from: "bafy-old",
        pointer: { rootCid: "bafy-new", runId: "20260911T131000Z" },
      }),
    } as unknown as RefreshTarget;

    await observePointerRefresh(current);

    expect(telemetry.addMetric).toHaveBeenCalledWith("DatasetUpgraded", "Count", 1);
    expect(telemetry.publish).toHaveBeenCalledOnce();
  });

  it("records and flushes a reported refresh failure", async () => {
    const current = {
      refresh: vi.fn().mockResolvedValue({ status: "failed", error: new Error("gateway") }),
    } as unknown as RefreshTarget;

    await observePointerRefresh(current);

    expect(telemetry.warn).toHaveBeenCalledWith("pointer_refresh_failed", {
      error: "gateway",
    });
    expect(telemetry.addMetric).toHaveBeenCalledWith("PointerRefreshFailed", "Count", 1);
    expect(telemetry.publish).toHaveBeenCalledOnce();
  });

  it("records and flushes a rejected refresh promise", async () => {
    const current = {
      refresh: vi.fn().mockRejectedValue(new Error("unexpected refresh rejection")),
    } as unknown as RefreshTarget;

    await observePointerRefresh(current);

    expect(telemetry.warn).toHaveBeenCalledWith("pointer_refresh_failed", {
      error: "Error: unexpected refresh rejection",
    });
    expect(telemetry.addMetric).toHaveBeenCalledWith("PointerRefreshFailed", "Count", 1);
    expect(telemetry.publish).toHaveBeenCalledOnce();
  });
});
