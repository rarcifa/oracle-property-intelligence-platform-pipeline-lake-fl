import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  promoteCertifiedClermontBaseline,
  requireClermontBaselineForPublication,
} from "../src/batch/clermont-baseline-store.js";
import { clermontBaselineDigest } from "../src/batch/clermont-contracts.js";
import {
  completeClermontStage,
  prepareClermontCoordinator,
  startClermontStage,
  type ClermontStageName,
} from "../src/batch/clermont-coordinator.js";
import {
  clermontSignatures,
  syntheticClermontBaseline,
  syntheticClermontRequest,
  writeSyntheticClermontArtifacts,
} from "./clermont-batch-fixtures.js";

describe("Clermont clean-runner offline simulation", () => {
  it("plans, reconciles, promotes, and gates publication using only synthetic fixtures", async () => {
    const now = "2026-09-11T09:00:00.000Z";
    const request = syntheticClermontRequest({ refreshMode: "full" });
    let coordinator = prepareClermontCoordinator({
      request,
      baseline: null,
      now,
    });
    expect(coordinator.estimate.requiresManualAuthorization).toBe(false);
    expect(coordinator.refreshPlan.partitions).toHaveLength(12);
    expect(coordinator.refreshPlan.partitions.every(({ action }) => action === "full-year")).toBe(
      true,
    );

    const stages: ClermontStageName[] = [
      "enumeration",
      "acquisition",
      "reconciliation",
      "certification",
      "baseline-promotion",
      "publication-readiness",
    ];
    for (const [index, stage] of stages.entries()) {
      coordinator = startClermontStage(coordinator, stage, now);
      coordinator = completeClermontStage(
        coordinator,
        stage,
        `${(index + 10).toString(16)}`.repeat(64),
        now,
      );
    }
    expect(coordinator.state).toBe("COMPLETE");

    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "clermont-clean-runner-"));
    const candidate = syntheticClermontBaseline();
    const artifactRoot = path.join(storeRoot, "candidate");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const pointer = await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate,
      now,
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: null,
    });
    const publicationCandidate = await requireClermontBaselineForPublication({
      storeRoot,
      now,
      maxAgeHours: 24 * 7,
      expectedSignatures: clermontSignatures,
      expectedSha256: pointer.baselineSha256,
    });
    expect(clermontBaselineDigest(publicationCandidate)).toBe(pointer.baselineSha256);
  });
});
