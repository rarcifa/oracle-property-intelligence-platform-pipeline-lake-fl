import { describe, expect, it } from "vitest";

import {
  assertCostAllowed,
  planBatchCost,
  planPermitBatchCost,
} from "../src/batch/cost-plan.js";
import { syntheticRequest } from "./batch-fixtures.js";

describe("county-enrichment conservative cost gate", () => {
  it("derives one cost component per request category", () => {
    const twoCategoryPlan = assertCostAllowed(
      syntheticRequest({ categoryCount: 2 }),
    );
    const fourCategoryPlan = assertCostAllowed(
      syntheticRequest({
        countyKey: "second-synthetic-county",
        categoryCount: 4,
      }),
    );

    expect(
      twoCategoryPlan.components.filter(({ name }) =>
        name.startsWith("bbb:"),
      ),
    ).toHaveLength(2);
    expect(
      fourCategoryPlan.components.filter(({ name }) =>
        name.startsWith("bbb:"),
      ),
    ).toHaveLength(4);
    expect(fourCategoryPlan.estimatedUsd).toBeGreaterThan(
      twoCategoryPlan.estimatedUsd,
    );
  });

  it("fails closed against request and deployment ceilings", () => {
    const request = syntheticRequest({
      categoryCount: 4,
      costCeilingUsd: 10,
    });
    request.bbb.bounds.maxDurationMinutes = 360;
    const plan = planBatchCost(request);

    expect(plan.allowed).toBe(true);
    expect(() => assertCostAllowed(request, 5)).toThrow(
      /exceeds the deployment ceiling/,
    );
    request.costCeilingUsd = 5;
    expect(() => assertCostAllowed(request)).toThrow(
      /exceeds the configured/,
    );
  });

  it("bounds the separate permit worker from input size before source reads", () => {
    const allowed = planPermitBatchCost(120_051_259, 64_000, 5);
    expect(allowed.allowed).toBe(true);
    expect(allowed.components.map(({ name }) => name)).toEqual([
      "permit-transform",
      "permit-input-volume",
      "s3-logs-requests",
    ]);

    const blocked = planPermitBatchCost(120_051_259, 64_000, 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.estimatedUsd).toBe(allowed.estimatedUsd);
    expect(() => planPermitBatchCost(0, 64_000, 5)).toThrow(/positive integer/);
  });
});
