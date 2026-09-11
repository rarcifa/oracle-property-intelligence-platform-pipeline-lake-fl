import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { CLERMONT_PERMIT_YEARS, clermontPartitionHandoffSchema } from "./clermont-contracts.js";
import {
  clermontRunDirectory,
  loadClermontCoordinator,
  loadClermontPreparedRun,
  loadClermontWorker,
} from "./clermont-run-store.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getClermontRunStatus(options: {
  runStore: string;
  runId: string;
  now: string;
}) {
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  const coordinator = await loadClermontCoordinator(options.runStore, options.runId);
  const runDirectory = clermontRunDirectory(options.runStore, options.runId);
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
  const promoted = await exists(
    path.join(runDirectory, "promotion", "local-promotion-receipt.json"),
  );
  const remotelyPromoted = await exists(
    path.join(runDirectory, "promotion", "s3-promotion-receipt.json"),
  );
  const certified = await exists(path.join(runDirectory, "candidate", "baseline.json"));
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
    );
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
              : promoted
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
        : promoted
          ? "Authorize publication separately after all county-wide source and privacy gates pass."
          : null,
    clermontSourceCompletenessEstablished: terminalSource && remotelyPromoted,
    countyCompletenessEstablished: false,
    publicationAvailability: "unsupported",
    loadedWatermarkNewerThanPublished: promoted,
  };
}
