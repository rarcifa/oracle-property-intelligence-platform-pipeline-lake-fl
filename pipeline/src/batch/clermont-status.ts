import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "./contracts.js";
import { clermontCertificationEvidenceDigest } from "./clermont-certifier.js";
import {
  CLERMONT_PERMIT_YEARS,
  clermontBaselineDigest,
  clermontCertifiedBaselineSchema,
  clermontPartitionHandoffSchema,
  type ClermontCertifiedBaseline,
  type ClermontImmutableArtifact,
} from "./clermont-contracts.js";
import {
  clermontConsumptionRequestSchema,
  clermontLocalPromotionReceiptSchema,
} from "./clermont-run-contracts.js";
import { clermontS3PromotionReceiptSchema } from "./clermont-s3-baseline-store.js";
import {
  clermontRunDirectory,
  loadClermontCoordinator,
  loadClermontPreparedRun,
  loadClermontWorker,
} from "./clermont-run-store.js";

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { malformedJson: true };
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function expectedRemoteArtifacts(
  baseline: ClermontCertifiedBaseline,
  baselineSha256: string,
  prefix: string,
): Array<ClermontImmutableArtifact & { key: string }> {
  const artifacts: ClermontImmutableArtifact[] = [
    {
      logicalPath: "baseline.json",
      sha256: baselineSha256,
      bytes: Buffer.byteLength(canonicalJson(baseline)),
    },
    ...baseline.partitions.flatMap(({ artifacts: partitionArtifacts }) =>
      Object.values(partitionArtifacts),
    ),
    baseline.mergedExport.artifact,
    baseline.mergedExport.metadata,
  ];
  const unique = new Map<string, ClermontImmutableArtifact>();
  for (const artifact of artifacts) {
    const prior = unique.get(artifact.logicalPath);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(artifact)) {
      throw new Error("Certified baseline has conflicting duplicate artifact paths");
    }
    unique.set(artifact.logicalPath, artifact);
  }
  return [...unique.values()]
    .map((artifact) => ({
      ...artifact,
      key: `${prefix}/baselines/${baselineSha256}/${artifact.logicalPath}`,
    }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export async function getClermontRunStatus(options: {
  runStore: string;
  runId: string;
  now: string;
}) {
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  const coordinator = await loadClermontCoordinator(options.runStore, options.runId);
  const runDirectory = clermontRunDirectory(options.runStore, options.runId);
  const promotionEvidenceIssues: string[] = [];
  const handoffs = [];
  const workers = [];
  for (const year of CLERMONT_PERMIT_YEARS) {
    workers.push(
      await loadClermontWorker(options.runStore, options.runId, `lake-clermont-etrakit-${year}`),
    );
    const handoffPath = path.join(
      runDirectory,
      "candidate",
      "partitions",
      String(year),
      "handoff.json",
    );
    if (await exists(handoffPath)) {
      handoffs.push(
        clermontPartitionHandoffSchema.parse(JSON.parse(await readFile(handoffPath, "utf8"))),
      );
    }
  }
  const candidateResult = clermontCertifiedBaselineSchema.safeParse(
    await readOptionalJson(path.join(runDirectory, "candidate", "baseline.json")),
  );
  const baseline = candidateResult.success ? candidateResult.data : null;
  if (!candidateResult.success)
    promotionEvidenceIssues.push("candidate-baseline-missing-or-invalid");
  const baselineSha256 = baseline === null ? null : clermontBaselineDigest(baseline);
  const recomputedCertificationEvidence =
    baseline === null
      ? null
      : clermontCertificationEvidenceDigest({
          requestSha256: prepared.requestSha256,
          provenanceSha256: prepared.provenanceSha256,
          handoffs: baseline.partitions,
          mergedExport: baseline.mergedExport,
        });
  const certified =
    baseline !== null &&
    baseline.evidenceSha256 === recomputedCertificationEvidence &&
    baseline.partitions.every(({ runId }) => runId === options.runId) &&
    canonicalJson(baseline.signatures) === canonicalJson(prepared.request.signatures) &&
    coordinator.stages.certification.status === "complete" &&
    coordinator.stages.certification.evidenceSha256 === baseline.evidenceSha256;
  if (baseline !== null && !certified) promotionEvidenceIssues.push("certification-unbound");

  const localReceiptResult = clermontLocalPromotionReceiptSchema.safeParse(
    await readOptionalJson(path.join(runDirectory, "promotion", "local-promotion-receipt.json")),
  );
  const consumptionResult = clermontConsumptionRequestSchema.safeParse(
    await readOptionalJson(path.join(runDirectory, "promotion", "consumption-request.json")),
  );
  const promoted =
    certified &&
    baseline !== null &&
    baselineSha256 !== null &&
    localReceiptResult.success &&
    consumptionResult.success &&
    localReceiptResult.data.runId === options.runId &&
    localReceiptResult.data.pointer.baselineSha256 === baselineSha256 &&
    consumptionResult.data.createdAt === localReceiptResult.data.promotedAt &&
    consumptionResult.data.expiresAt === baseline.expiresAt &&
    consumptionResult.data.baselineSha256 === baselineSha256 &&
    consumptionResult.data.exportSha256 === baseline.mergedExport.artifact.sha256 &&
    consumptionResult.data.metadataSha256 === baseline.mergedExport.metadata.sha256 &&
    canonicalJson(consumptionResult.data.signatures) === canonicalJson(prepared.request.signatures);
  if (!promoted && (localReceiptResult.success || consumptionResult.success)) {
    promotionEvidenceIssues.push("local-promotion-unbound");
  } else if (!localReceiptResult.success && !consumptionResult.success) {
    promotionEvidenceIssues.push("local-promotion-missing-or-invalid");
  }

  const s3ReceiptResult = clermontS3PromotionReceiptSchema.safeParse(
    await readOptionalJson(path.join(runDirectory, "promotion", "s3-promotion-receipt.json")),
  );
  const expectedRemote =
    baseline === null || baselineSha256 === null
      ? []
      : expectedRemoteArtifacts(baseline, baselineSha256, prepared.request.remoteBaseline.prefix);
  const actualRemote = s3ReceiptResult.success
    ? s3ReceiptResult.data.objects
        .map(({ action: _action, etag: _etag, ...artifact }) => artifact)
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    : [];
  const expectedRemoteProjection = expectedRemote.map(
    ({ logicalPath: _logicalPath, ...artifact }) => artifact,
  );
  const remoteStagesComplete =
    baselineSha256 !== null &&
    coordinator.stages["baseline-promotion"].status === "complete" &&
    coordinator.stages["baseline-promotion"].evidenceSha256 === baselineSha256 &&
    coordinator.stages["publication-readiness"].status === "complete" &&
    coordinator.stages["publication-readiness"].evidenceSha256 === baselineSha256;
  const remotelyPromoted =
    promoted &&
    baselineSha256 !== null &&
    s3ReceiptResult.success &&
    s3ReceiptResult.data.accountId === prepared.request.remoteBaseline.accountId &&
    s3ReceiptResult.data.region === prepared.request.remoteBaseline.region &&
    s3ReceiptResult.data.bucket === prepared.request.remoteBaseline.bucket &&
    s3ReceiptResult.data.prefix === prepared.request.remoteBaseline.prefix &&
    s3ReceiptResult.data.baselineSha256 === baselineSha256 &&
    s3ReceiptResult.data.pointerKey ===
      `${prepared.request.remoteBaseline.prefix}/last-good.json` &&
    canonicalJson(actualRemote) === canonicalJson(expectedRemoteProjection) &&
    remoteStagesComplete;
  if (!remotelyPromoted) promotionEvidenceIssues.push("remote-promotion-missing-or-unbound");
  const captured = handoffs.reduce((sum, handoff) => sum + handoff.counts.completed, 0);
  const provenDead = handoffs.reduce((sum, handoff) => sum + handoff.counts.provenDead, 0);
  const pending = handoffs.reduce((sum, handoff) => sum + handoff.counts.retryablePending, 0);
  const linked = handoffs.reduce((sum, handoff) => sum + handoff.counts.linked, 0);
  const validUnlinked = handoffs.reduce((sum, handoff) => sum + handoff.counts.validUnlinked, 0);
  const cappedYears = handoffs
    .filter(({ cappedOrTruncated }) => cappedOrTruncated)
    .map(({ year }) => year);
  const exhausted = workers.filter(({ status }) => status === "failed_exhausted");
  const cooling = workers.filter(({ status }) => status === "cooling_down");
  const running = workers.filter(({ status }) => status === "running");
  const blocked = coordinator.state === "WAITING_HUMAN";
  const terminalSource =
    handoffs.length === 12 &&
    handoffs.every(
      ({ status, cappedOrTruncated, counts }) =>
        status === "captured_complete" && !cappedOrTruncated && counts.retryablePending === 0,
    ) &&
    (baseline === null || canonicalJson(handoffs) === canonicalJson(baseline.partitions));
  const blockerCategory = blocked
    ? "cost-or-duration-authorization"
    : cappedYears.length > 0
      ? "source-cap"
      : exhausted.length > 0
        ? "retry-budget-exhausted"
        : pending > 0 || cooling.length > 0
          ? "retryable-source-work"
          : terminalSource && !certified
            ? "certification-pending"
            : certified && !promoted
              ? "promotion-pending"
              : promoted && !remotelyPromoted
                ? "remote-baseline-promotion-pending"
                : remotelyPromoted
                  ? "external-publication-pending"
                  : "acquisition-pending";
  const nextAutomatedAction = blocked
    ? null
    : !terminalSource
      ? "run"
      : !certified
        ? "certify"
        : !promoted
          ? "promote"
          : !remotelyPromoted
            ? "sync-promote"
            : "materialize-consumption";
  return {
    schemaVersion: "elephant.clermont-permit-status.v1",
    observedAt: options.now,
    runId: options.runId,
    durableRun: {
      state: coordinator.state,
      revision: coordinator.revision,
      provenanceDigest: prepared.provenanceSha256,
      nextAutomaticTransition: nextAutomatedAction,
    },
    sourceBoundary: { county: "lake", jurisdiction: "clermont", years: CLERMONT_PERMIT_YEARS },
    counts: {
      reportedEstimate: prepared.request.benchmark.expectedByYear.reduce(
        (sum, value) => sum + value.expectedRecords,
        0,
      ),
      enumerated: handoffs.reduce((sum, handoff) => sum + handoff.counts.enumerated, 0),
      captured,
      provenDead,
      retryablePending: pending,
      loaded: promoted ? captured : 0,
      published: null,
      linked,
      validUnlinked,
    },
    workers: {
      active: running.map(({ partitionId }) => partitionId),
      cooling: cooling.map(({ partitionId, nextAttemptAt }) => ({ partitionId, nextAttemptAt })),
      paused: exhausted.map(({ partitionId }) => partitionId),
      blocked: blocked ? ["cost-prediction"] : cappedYears.map((year) => `year-${year}-source-cap`),
      heartbeatFresh: running.every(
        ({ heartbeatAt, leaseExpiresAt }) =>
          heartbeatAt !== null &&
          leaseExpiresAt !== null &&
          Date.parse(leaseExpiresAt) > Date.parse(options.now),
      ),
      leases: workers.map(
        ({
          partitionId,
          fencingToken,
          heartbeatAt,
          leaseExpiresAt,
          checkpointSha256,
          attempts,
        }) => ({
          partitionId,
          fencingToken,
          heartbeatAt,
          leaseExpiresAt,
          checkpointSha256,
          attempts,
          retryBudgetRemaining: prepared.request.limits.maxAttempts - attempts,
        }),
      ),
    },
    blockerCategory,
    nextAutomatedAction,
    requiredHumanAction: blocked
      ? "Approve the exact cost-estimate digest in a fresh prepare template."
      : exhausted.length > 0 || cappedYears.length > 0
        ? "Review the finite source-cap or exhausted-worker evidence; do not certify until resolved."
        : remotelyPromoted
          ? "Authorize publication separately after all county-wide source and privacy gates pass."
          : promoted
            ? "Complete the prepared, account-bound remote baseline promotion."
            : null,
    clermontSourceCompletenessEstablished: terminalSource && remotelyPromoted,
    promotionEvidenceIssues,
    countyCompletenessEstablished: false,
    publicationAvailability: "unsupported",
    loadedWatermarkNewerThanPublished: promoted,
  };
}
