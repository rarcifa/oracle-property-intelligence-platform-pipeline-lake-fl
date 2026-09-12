import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({
  addDimension: vi.fn(),
  addMetric: vi.fn(),
  publish: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  metricOptions: vi.fn(),
  loggerOptions: vi.fn(),
}));

vi.mock("@aws-lambda-powertools/logger", () => ({
  Logger: class {
    constructor(options: unknown) {
      telemetry.loggerOptions(options);
    }
    info = telemetry.info;
    error = telemetry.error;
  },
}));

vi.mock("@aws-lambda-powertools/metrics", () => ({
  MetricUnit: { Count: "Count", Milliseconds: "Milliseconds", NoUnit: "None" },
  Metrics: class {
    constructor(options: unknown) {
      telemetry.metricOptions(options);
    }
    addDimension = telemetry.addDimension;
    addMetric = telemetry.addMetric;
    publishStoredMetrics = telemetry.publish;
  },
}));

import {
  createBatchWorkerObserver,
  emitBatchCostPrediction,
} from "../src/batch/worker-observability.js";

const originalOperation = process.env.ORACLE_METRIC_OPERATION;

afterEach(() => {
  if (originalOperation === undefined) delete process.env.ORACLE_METRIC_OPERATION;
  else process.env.ORACLE_METRIC_OPERATION = originalOperation;
});

beforeEach(() => vi.clearAllMocks());

describe("AWS Batch worker observability", () => {
  it("emits one processed result and duration with exact low-cardinality dimensions", async () => {
    const observer = createBatchWorkerObserver("sunbiz", "test");

    await expect(observer.run(async () => "done")).resolves.toBe("done");
    expect(telemetry.metricOptions).toHaveBeenCalledWith({
      namespace: "OracleLake",
      serviceName: "county-enrichment-sunbiz",
    });
    expect(telemetry.loggerOptions).toHaveBeenCalledWith({
      serviceName: "county-enrichment-sunbiz",
    });
    expect(telemetry.addDimension).toHaveBeenCalledWith("environment", "test");
    expect(telemetry.addDimension).toHaveBeenCalledWith("operation", "sunbiz");
    expect(telemetry.addMetric).toHaveBeenCalledWith("StageProcessed", "Count", 1);
    expect(telemetry.addMetric).toHaveBeenCalledWith(
      "ProcessingDuration",
      "Milliseconds",
      expect.any(Number),
    );
    expect(telemetry.addMetric).not.toHaveBeenCalledWith("StageFailed", "Count", 1);
    expect(telemetry.publish).toHaveBeenCalledOnce();
  });

  it("emits one failed result and duration before preserving the worker error", async () => {
    const observer = createBatchWorkerObserver("permit", "test");
    const failure = new Error("synthetic worker failure");

    await expect(observer.run(async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(telemetry.addDimension).toHaveBeenCalledWith("operation", "permit");
    expect(telemetry.addMetric).toHaveBeenCalledWith("StageFailed", "Count", 1);
    expect(telemetry.addMetric).toHaveBeenCalledWith(
      "ProcessingDuration",
      "Milliseconds",
      expect.any(Number),
    );
    expect(telemetry.addMetric).not.toHaveBeenCalledWith("StageProcessed", "Count", 1);
    expect(telemetry.publish).toHaveBeenCalledOnce();
    expect(telemetry.error).toHaveBeenCalledWith(
      "worker_failed",
      expect.objectContaining({ operation: "permit", errorName: "Error" }),
    );
  });

  it("rejects a deployment operation that disagrees with the worker command", () => {
    process.env.ORACLE_METRIC_OPERATION = "bbb";
    expect(() => createBatchWorkerObserver("sunbiz")).toThrow(/does not match worker operation/);
  });

  it("emits the unitless USD prediction against the exact stack project name", () => {
    emitBatchCostPrediction(3.125, "county-enrichment");

    expect(telemetry.metricOptions).toHaveBeenCalledWith({
      namespace: "OracleLake",
      serviceName: "county-enrichment",
    });
    expect(telemetry.addDimension).toHaveBeenCalledWith("service", "county-enrichment");
    expect(telemetry.addMetric).toHaveBeenCalledWith("CostPredicted", "None", 3.125);
    expect(telemetry.publish).toHaveBeenCalledOnce();
  });

  it("rejects an invalid predicted cost before emitting it", () => {
    expect(() => emitBatchCostPrediction(Number.NaN)).toThrow(/non-negative finite/);
    expect(telemetry.addMetric).not.toHaveBeenCalled();
  });

  it("gates the separate permit worker before any S3 read or source download", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/batch/permit-worker.ts", import.meta.url)),
      "utf8",
    );
    const main = source.slice(source.indexOf("async function main"));
    const planned = main.indexOf("planPermitBatchCost(");
    const emitted = main.indexOf("emitBatchCostPrediction(");
    const enforced = main.indexOf("if (!costPlan.allowed)");
    const firstS3Read = main.indexOf("getVerifiedJsonIfExists(");
    const firstSourceDownload = main.indexOf("downloadVerifiedObject(");

    expect(planned).toBeGreaterThanOrEqual(0);
    expect(emitted).toBeGreaterThan(planned);
    expect(enforced).toBeGreaterThan(emitted);
    expect(firstS3Read).toBeGreaterThan(enforced);
    expect(firstSourceDownload).toBeGreaterThan(firstS3Read);
  });
});
