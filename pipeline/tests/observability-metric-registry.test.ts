import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  BATCH_COST_METRIC_NAME,
  BATCH_PROJECT_NAME,
  BATCH_WORKERS,
  BATCH_WORKER_METRIC_NAMES,
} from "../src/batch/worker-observability.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const registrySchema = z.object({
  schemaVersion: z.literal("oracle.observability-metrics.v1"),
  namespace: z.literal("OracleLake"),
  registrationMode: z.literal("repository-equivalent"),
  externalTargets: z.object({ lexicon: z.string().min(1), dashboard: z.string().min(1) }),
  metrics: z.array(
    z.object({
      name: z.string().regex(/^[A-Z][A-Za-z0-9]+$/),
      unit: z.enum(["Count", "Milliseconds", "None"]),
      service: z.enum([
        "runtime",
        "pagerduty-notifier",
        BATCH_PROJECT_NAME,
        ...Object.values(BATCH_WORKERS),
      ]),
      operation: z.enum(["sunbiz", "bbb", "reconciliation", "permit"]).optional(),
    }),
  ),
});

function emittedMetricNames(source: string): string[] {
  return [...source.matchAll(/(?:metrics|refreshMetrics)\.addMetric\("([A-Za-z0-9]+)"/g)].map(
    (match) => match[1]!,
  );
}

describe("repository-equivalent metric registration", () => {
  it("registers and dashboards every Powertools metric emitted by runtime, notifier and workers", async () => {
    const [registryText, runtimeSource, notifierSource, stackSource, batchStackSource] =
      await Promise.all([
        readFile(`${repositoryRoot}docs/observability-metrics.json`, "utf8"),
        readFile(`${repositoryRoot}packages/server/src/lambda.ts`, "utf8"),
        readFile(
          `${repositoryRoot}packages/server/src/observability/pagerduty-notifier.ts`,
          "utf8",
        ),
        readFile(`${repositoryRoot}infra/lake-runtime-stack.ts`, "utf8"),
        readFile(`${repositoryRoot}pipeline/infra/county-enrichment-batch-stack.ts`, "utf8"),
      ]);
    const registry = registrySchema.parse(JSON.parse(registryText));
    const key = (service: string, name: string): string => `${service}/${name}`;
    const registered = registry.metrics.map((metric) => key(metric.service, metric.name));
    expect(new Set(registered).size).toBe(registered.length);

    const emitted = new Set([
      ...emittedMetricNames(runtimeSource).map((name) => key("runtime", name)),
      ...emittedMetricNames(notifierSource).map((name) => key("pagerduty-notifier", name)),
      ...Object.entries(BATCH_WORKERS).flatMap(([, service]) =>
        Object.values(BATCH_WORKER_METRIC_NAMES).map((name) => key(service, name)),
      ),
      key(BATCH_PROJECT_NAME, BATCH_COST_METRIC_NAME),
    ]);
    expect([...registered].sort()).toEqual([...emitted].sort());

    for (const metric of registry.metrics) {
      if (metric.service === BATCH_PROJECT_NAME) {
        expect(metric.name).toBe(BATCH_COST_METRIC_NAME);
        expect(batchStackSource).toContain("BATCH_COST_METRIC_NAME");
      } else if (metric.operation === undefined) {
        expect(stackSource).toContain(`"${metric.name}"`);
      } else {
        expect(metric.service).toBe(BATCH_WORKERS[metric.operation]);
        expect(batchStackSource).toContain("BATCH_WORKER_METRIC_NAMES");
        expect(batchStackSource).toContain("BATCH_WORKERS");
      }
    }
  });
});
