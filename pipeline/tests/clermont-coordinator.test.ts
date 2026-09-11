import { describe, expect, it } from "vitest";

import { clermontRunRequestSchema } from "../src/batch/clermont-contracts.js";
import {
  acquireClermontWorkerLease,
  buildClermontRefreshPlan,
  completeClermontStage,
  createClermontWorkerState,
  evaluateClermontCostGate,
  estimateClermontRun,
  failClermontWorkerAttempt,
  hasValidEstimateAuthorization,
  heartbeatClermontWorker,
  prepareClermontCoordinator,
  startClermontStage,
  type ClermontStageName,
} from "../src/batch/clermont-coordinator.js";
import {
  clermontSignatures,
  syntheticClermontBaseline,
  syntheticClermontRequest,
} from "./clermont-batch-fixtures.js";

const NOW = "2026-09-11T09:00:00.000Z";

describe("Clermont refresh planning and cost gate", () => {
  it("reuses closed old years, refreshes their open records, and fully refreshes recent years", () => {
    const baseline = syntheticClermontBaseline({ openYears: [2020, 2026] });
    const request = syntheticClermontRequest({ baseline });
    const plan = buildClermontRefreshPlan({ request, baseline });

    expect(plan.partitions.find(({ year }) => year === 2019)?.action).toBe("reuse-immutable");
    expect(plan.partitions.find(({ year }) => year === 2020)).toMatchObject({
      action: "open-records",
      expectedRecords: 1,
      stableIds: ["lake:clermont:etrakit:2020-0001"],
    });
    expect(plan.partitions.find(({ year }) => year === 2025)?.action).toBe("recent-year");
    expect(plan.partitions.find(({ year }) => year === 2026)?.action).toBe("recent-year");
  });

  it("stops above 48 hours until authorization is bound to the exact estimate", () => {
    const baseline = syntheticClermontBaseline();
    const request = syntheticClermontRequest({
      baseline,
      terminalRecordsPerHour: 1,
      costCeilingUsd: 100,
    });
    const estimate = evaluateClermontCostGate({ request, now: NOW }).estimate;

    expect(estimate.estimatedHours).toBeGreaterThan(48);
    expect(estimate.authorizationReasons).toEqual(["duration"]);
    expect(prepareClermontCoordinator({ request, baseline, now: NOW }).state).toBe("WAITING_HUMAN");
    // Cost is the first gate: an over-duration request pauses before the
    // baseline is opened or validated.
    expect(prepareClermontCoordinator({ request, baseline: null, now: NOW }).state).toBe(
      "WAITING_HUMAN",
    );

    const authorized = clermontRunRequestSchema.parse({
      ...request,
      authorization: {
        estimateSha256: estimate.estimateSha256,
        approvedBy: "synthetic-operator",
        approvedAt: "2026-09-11T08:55:00.000Z",
        expiresAt: "2026-09-11T10:00:00.000Z",
      },
    });
    expect(
      hasValidEstimateAuthorization({
        request: authorized,
        estimate,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      prepareClermontCoordinator({
        request: authorized,
        baseline,
        now: NOW,
      }).state,
    ).toBe("READY");

    const wrongEstimate = clermontRunRequestSchema.parse({
      ...authorized,
      authorization: {
        ...authorized.authorization!,
        estimateSha256: "f".repeat(64),
      },
    });
    expect(
      prepareClermontCoordinator({
        request: wrongEstimate,
        baseline,
        now: NOW,
      }).state,
    ).toBe("WAITING_HUMAN");
  });

  it("reports cost-ceiling breaches independently of duration", () => {
    const baseline = syntheticClermontBaseline();
    const request = syntheticClermontRequest({
      baseline,
      costCeilingUsd: 0.01,
      runnerHourlyUsd: 1,
    });
    const estimate = estimateClermontRun(request, buildClermontRefreshPlan({ request, baseline }));
    expect(estimate.estimatedHours).toBeLessThan(48);
    expect(estimate.authorizationReasons).toContain("cost");
    expect(estimate.requiresManualAuthorization).toBe(true);
  });

  it("fails closed on missing, stale, or incompatible incremental baselines", () => {
    const baseline = syntheticClermontBaseline();
    const request = syntheticClermontRequest({ baseline });
    expect(() => prepareClermontCoordinator({ request, baseline: null, now: NOW })).toThrow(
      /requires a certified immutable last-good baseline/,
    );

    const stale = syntheticClermontBaseline({
      expiresAt: "2026-09-11T08:59:59.000Z",
    });
    expect(() =>
      prepareClermontCoordinator({
        request: syntheticClermontRequest({ baseline: stale }),
        baseline: stale,
        now: NOW,
      }),
    ).toThrow(/stale/);

    const incompatibleRequest = syntheticClermontRequest({
      baseline,
      signatures: {
        ...clermontSignatures,
        schemaSha256: "f".repeat(64),
      },
    });
    expect(() =>
      prepareClermontCoordinator({
        request: incompatibleRequest,
        baseline,
        now: NOW,
      }),
    ).toThrow(/signature is incompatible/);
  });
});

describe("Clermont local coordinator stage machine", () => {
  it("enforces dependencies and advances automatically to publication readiness", () => {
    const baseline = syntheticClermontBaseline();
    const request = syntheticClermontRequest({ baseline });
    let state = prepareClermontCoordinator({ request, baseline, now: NOW });
    expect(state.nextAutomaticTransition).toBe("enumeration");
    expect(() => startClermontStage(state, "acquisition", NOW)).toThrow(/incomplete dependencies/);

    const stages: ClermontStageName[] = [
      "enumeration",
      "acquisition",
      "reconciliation",
      "certification",
      "baseline-promotion",
      "publication-readiness",
    ];
    for (const [index, stage] of stages.entries()) {
      state = startClermontStage(state, stage, NOW);
      state = completeClermontStage(state, stage, `${(index + 10).toString(16)}`.repeat(64), NOW);
    }
    expect(state.state).toBe("COMPLETE");
    expect(state.nextAutomaticTransition).toBeNull();
    expect(state.stages["publication-readiness"].status).toBe("complete");
  });
});

describe("Clermont leases, fencing, heartbeat, cooldown, and retry budgets", () => {
  it("rejects competing writers and stale fencing tokens", () => {
    const request = syntheticClermontRequest();
    const worker = createClermontWorkerState(2026, clermontSignatures);
    const first = acquireClermontWorkerLease({
      worker,
      request,
      owner: "worker-a",
      now: NOW,
    });
    expect(() =>
      acquireClermontWorkerLease({
        worker: first,
        request,
        owner: "worker-b",
        now: "2026-09-11T09:00:10.000Z",
      }),
    ).toThrow(/unexpired lease/);

    const recovered = acquireClermontWorkerLease({
      worker: first,
      request,
      owner: "worker-b",
      now: "2026-09-11T09:01:01.000Z",
    });
    expect(recovered.fencingToken).toBe(first.fencingToken + 1);
    expect(() =>
      heartbeatClermontWorker({
        worker: recovered,
        request,
        owner: "worker-a",
        fencingToken: first.fencingToken,
        checkpointSha256: "a".repeat(64),
        checkpointSignatures: clermontSignatures,
        now: "2026-09-11T09:01:02.000Z",
      }),
    ).toThrow(/stale/);
  });

  it("uses bounded jittered cooldowns, opens the circuit, and exhausts attempts", () => {
    const request = syntheticClermontRequest();
    let worker = createClermontWorkerState(2026, clermontSignatures);

    for (let attempt = 1; attempt <= request.limits.maxAttempts; attempt += 1) {
      const acquireAt =
        worker.nextAttemptAt ?? new Date(Date.parse(NOW) + (attempt - 1) * 120_000).toISOString();
      worker = acquireClermontWorkerLease({
        worker,
        request,
        owner: "worker-a",
        now: acquireAt,
      });
      const failureAt = new Date(Date.parse(acquireAt) + 100).toISOString();
      worker = failClermontWorkerAttempt({
        worker,
        request,
        owner: "worker-a",
        fencingToken: worker.fencingToken,
        now: failureAt,
      });
      if (attempt < request.limits.maxAttempts) {
        expect(worker.status).toBe("cooling_down");
        expect(worker.nextAttemptAt).not.toBeNull();
        expect(() =>
          acquireClermontWorkerLease({
            worker,
            request,
            owner: "worker-a",
            now: failureAt,
          }),
        ).toThrow(/valid cooldown/);
      }
    }

    expect(worker.status).toBe("failed_exhausted");
    expect(worker.circuit).toBe("open");
    expect(worker.attempts).toBe(request.limits.maxAttempts);
    expect(() =>
      acquireClermontWorkerLease({
        worker,
        request,
        owner: "worker-a",
        now: "2026-09-12T09:00:00.000Z",
      }),
    ).toThrow(/retry budget is exhausted/);
  });

  it("rejects checkpoints from a different source/config/schema", () => {
    const request = syntheticClermontRequest();
    const worker = acquireClermontWorkerLease({
      worker: createClermontWorkerState(2026, clermontSignatures),
      request,
      owner: "worker-a",
      now: NOW,
    });
    expect(() =>
      heartbeatClermontWorker({
        worker,
        request,
        owner: "worker-a",
        fencingToken: worker.fencingToken,
        checkpointSha256: "a".repeat(64),
        checkpointSignatures: {
          ...clermontSignatures,
          configurationSha256: "f".repeat(64),
        },
        now: "2026-09-11T09:00:05.000Z",
      }),
    ).toThrow(/incompatible/);
  });
});
