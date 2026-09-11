import { readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "./contracts.js";
import { CLERMONT_PERMIT_YEARS, clermontCertifiedBaselineSchema } from "./clermont-contracts.js";
import {
  materializeLastGoodClermontExport,
  promoteCertifiedClermontBaseline,
} from "./clermont-baseline-store.js";
import { startClermontStage } from "./clermont-coordinator.js";
import { verifyClermontPreparedScopes } from "./clermont-preparation.js";
import {
  CLERMONT_CONSUMPTION_REQUEST_SCHEMA_VERSION,
  clermontConsumptionRequestSchema,
  type ClermontConsumptionRequest,
} from "./clermont-run-contracts.js";
import {
  clermontRunDirectory,
  loadClermontCoordinator,
  loadClermontPreparedRun,
  writeClermontRunArtifact,
  updateClermontCoordinator,
} from "./clermont-run-store.js";

function confinedOutput(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const outputPath = path.resolve(resolvedRoot, relativePath);
  if (!outputPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Consumption output path escapes its output root");
  }
  return outputPath;
}

export async function promoteClermontRun(options: {
  repoRoot: string;
  runStore: string;
  baselineStore: string;
  runId: string;
  now: string;
  outputRelativePath?: string;
}): Promise<{
  baselineSha256: string;
  consumptionRequest: ClermontConsumptionRequest;
  consumptionRequestPath: string;
}> {
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  await verifyClermontPreparedScopes({ repoRoot: options.repoRoot, prepared });
  let coordinator = await loadClermontCoordinator(options.runStore, options.runId);
  if (coordinator.stages["baseline-promotion"].status !== "running") {
    coordinator = await updateClermontCoordinator({
      storeRoot: options.runStore,
      runId: options.runId,
      expectedRevision: coordinator.revision,
      update: (state) => startClermontStage(state, "baseline-promotion", options.now),
    });
  }
  const candidateRoot = path.join(
    clermontRunDirectory(options.runStore, options.runId),
    "candidate",
  );
  const baseline = clermontCertifiedBaselineSchema.parse(
    JSON.parse(await readFile(path.join(candidateRoot, "baseline.json"), "utf8")),
  );
  if (
    baseline.partitions.some(({ runId }) => runId !== options.runId) ||
    canonicalJson(baseline.signatures) !== canonicalJson(prepared.request.signatures)
  ) {
    throw new Error("Certified candidate does not belong to the prepared run");
  }
  const pointer = await promoteCertifiedClermontBaseline({
    storeRoot: options.baselineStore,
    candidateArtifactRoot: candidateRoot,
    candidate: baseline,
    now: options.now,
    expectedSignatures: prepared.request.signatures,
    expectedPriorSha256: prepared.request.baseline.requiredSha256,
  });
  const consumptionRequest = clermontConsumptionRequestSchema.parse({
    schemaVersion: CLERMONT_CONSUMPTION_REQUEST_SCHEMA_VERSION,
    consumer: "lake-consolidation",
    county: "lake",
    jurisdiction: "clermont",
    sourceSystem: "lake_clermont_etrakit_permits",
    createdAt: options.now,
    expiresAt: baseline.expiresAt,
    baselineSha256: pointer.baselineSha256,
    exportSha256: baseline.mergedExport.artifact.sha256,
    metadataSha256: baseline.mergedExport.metadata.sha256,
    signatures: baseline.signatures,
    outputRelativePath:
      options.outputRelativePath ?? "pipeline/data/downloads/lake/clermont-permits.csv",
    requestedYears: [...CLERMONT_PERMIT_YEARS],
  });
  const consumptionRequestPath = await writeClermontRunArtifact({
    storeRoot: options.runStore,
    runId: options.runId,
    relativePath: "promotion/consumption-request.json",
    value: consumptionRequest,
  });
  await writeClermontRunArtifact({
    storeRoot: options.runStore,
    runId: options.runId,
    relativePath: "promotion/local-promotion-receipt.json",
    value: {
      runId: options.runId,
      promotedAt: options.now,
      pointer,
      consumptionRequestPath: "promotion/consumption-request.json",
    },
  });
  return { baselineSha256: pointer.baselineSha256, consumptionRequest, consumptionRequestPath };
}

export async function materializeClermontConsumption(options: {
  consumptionRequestPath: string;
  baselineStore: string;
  outputRoot: string;
  now: string;
}): Promise<Awaited<ReturnType<typeof materializeLastGoodClermontExport>>> {
  const request = clermontConsumptionRequestSchema.parse(
    JSON.parse(await readFile(options.consumptionRequestPath, "utf8")),
  );
  if (Date.parse(request.expiresAt) <= Date.parse(options.now)) {
    throw new Error("Clermont consumption request has expired");
  }
  const result = await materializeLastGoodClermontExport({
    storeRoot: options.baselineStore,
    outputPath: confinedOutput(options.outputRoot, request.outputRelativePath),
    now: options.now,
    maxAgeHours: Math.max(
      1 / 60,
      (Date.parse(request.expiresAt) - Date.parse(request.createdAt)) / (60 * 60 * 1_000),
    ),
    expectedSignatures: request.signatures,
    expectedSha256: request.baselineSha256,
  });
  if (
    result.exportSha256 !== request.exportSha256 ||
    result.metadataSha256 !== request.metadataSha256
  ) {
    throw new Error("Materialized Clermont output does not match its consumption request");
  }
  return result;
}
