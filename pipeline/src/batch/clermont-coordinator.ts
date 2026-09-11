import { canonicalJson, sha256Text } from "./contracts.js";
import {
  CLERMONT_PERMIT_YEARS,
  clermontBaselineDigest,
  clermontCertifiedBaselineSchema,
  clermontPartitionId,
  clermontRecordEvidenceSchema,
  clermontRunRequestSchema,
  type ClermontCertifiedBaseline,
  type ClermontPartitionCounts,
  type ClermontRecordEvidence,
  type ClermontRunRequest,
  type ClermontSignatureSet,
} from "./clermont-contracts.js";

export const CLERMONT_COST_ESTIMATE_SCHEMA_VERSION = "elephant.clermont-permit-cost-estimate.v1";
export const CLERMONT_COORDINATOR_SCHEMA_VERSION = "elephant.clermont-permit-coordinator.v1";

export const CLERMONT_STAGE_DEPENDENCIES = Object.freeze({
  "cost-prediction": [] as const,
  "baseline-validation": ["cost-prediction"] as const,
  "refresh-planning": ["baseline-validation"] as const,
  enumeration: ["refresh-planning"] as const,
  acquisition: ["enumeration"] as const,
  reconciliation: ["acquisition"] as const,
  certification: ["reconciliation"] as const,
  "baseline-promotion": ["certification"] as const,
  "publication-readiness": ["baseline-promotion"] as const,
});

export type ClermontStageName = keyof typeof CLERMONT_STAGE_DEPENDENCIES;
export type ClermontStageStatus =
  | "pending"
  | "ready"
  | "running"
  | "cooling_down"
  | "waiting_human"
  | "complete"
  | "failed_exhausted";

export interface ClermontCostEstimate {
  schemaVersion: typeof CLERMONT_COST_ESTIMATE_SCHEMA_VERSION;
  expectedRecords: number;
  expectedRequests: number;
  expectedRawBytes: number;
  estimatedHours: number;
  estimatedCostUsd: number;
  costCeilingUsd: number;
  maxAutomaticHours: 48;
  safeConcurrency: number;
  requiresManualAuthorization: boolean;
  authorizationReasons: Array<"duration" | "cost">;
  estimateSha256: string;
}

export type ClermontRefreshAction =
  "full-year" | "recent-year" | "open-records" | "reuse-immutable";

export interface ClermontRefreshPartition {
  year: number;
  partitionId: string;
  action: ClermontRefreshAction;
  expectedRecords: number;
  stableIds: string[];
}

export interface ClermontRefreshPlan {
  basis: "execution" | "conservative-cost-bound";
  mode: ClermontRunRequest["refreshMode"];
  recentYearBoundary: number;
  baselineSha256: string | null;
  partitions: ClermontRefreshPartition[];
}

export interface ClermontStageState {
  status: ClermontStageStatus;
  attempt: number;
  evidenceSha256: string | null;
  updatedAt: string;
}

export interface ClermontCoordinatorState {
  schemaVersion: typeof CLERMONT_COORDINATOR_SCHEMA_VERSION;
  revision: number;
  runId: string;
  state: "READY" | "RUNNING" | "WAITING_HUMAN" | "FAILED_EXHAUSTED" | "COMPLETE";
  requestSha256: string;
  provenanceSha256: string;
  estimate: ClermontCostEstimate;
  refreshPlan: ClermontRefreshPlan;
  stages: Record<ClermontStageName, ClermontStageState>;
  nextAutomaticTransition: ClermontStageName | null;
}

export class ClermontBaselinePreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClermontBaselinePreconditionError";
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function assertExactSignatures(actual: ClermontSignatureSet, expected: ClermontSignatureSet): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ClermontBaselinePreconditionError(
      "Certified baseline source, configuration, or schema signature is incompatible",
    );
  }
}

export function requireCompatibleBaseline(options: {
  request: ClermontRunRequest;
  baseline: ClermontCertifiedBaseline | null;
  now: string;
}): ClermontCertifiedBaseline | null {
  const request = clermontRunRequestSchema.parse(options.request);
  if (request.refreshMode === "full" && options.baseline === null) return null;
  if (options.baseline === null) {
    throw new ClermontBaselinePreconditionError(
      "Incremental Clermont acquisition requires a certified immutable last-good baseline",
    );
  }

  const baseline = clermontCertifiedBaselineSchema.parse(options.baseline);
  const digest = clermontBaselineDigest(baseline);
  if (request.baseline.requiredSha256 !== digest) {
    throw new ClermontBaselinePreconditionError(
      "Certified baseline digest does not match the run request",
    );
  }
  assertExactSignatures(baseline.signatures, request.signatures);

  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Coordinator now value must be an ISO-8601 timestamp");
  }
  if (Date.parse(baseline.expiresAt) <= nowMs) {
    throw new ClermontBaselinePreconditionError("Certified Clermont baseline is stale");
  }
  const maximumAgeMs = request.baseline.maxAgeHours * 60 * 60 * 1_000;
  if (nowMs - Date.parse(baseline.certifiedAt) > maximumAgeMs) {
    throw new ClermontBaselinePreconditionError(
      "Certified Clermont baseline exceeds the configured maximum age",
    );
  }
  return baseline;
}

export function buildClermontRefreshPlan(options: {
  request: ClermontRunRequest;
  baseline: ClermontCertifiedBaseline | null;
}): ClermontRefreshPlan {
  const request = clermontRunRequestSchema.parse(options.request);
  const baseline =
    options.baseline === null ? null : clermontCertifiedBaselineSchema.parse(options.baseline);
  const expectedByYear = new Map(
    request.benchmark.expectedByYear.map(({ year, expectedRecords }) => [year, expectedRecords]),
  );
  const recentYearBoundary = request.asOfYear - 1;
  const byYear = new Map(baseline?.partitions.map((partition) => [partition.year, partition]));

  const partitions = CLERMONT_PERMIT_YEARS.map((year) => {
    const prior = byYear.get(year);
    if (request.refreshMode === "full") {
      return {
        year,
        partitionId: clermontPartitionId(year),
        action: "full-year" as const,
        expectedRecords: expectedByYear.get(year) ?? 0,
        stableIds: [],
      };
    }
    if (!prior) {
      throw new ClermontBaselinePreconditionError(
        `Certified baseline is missing partition ${year}`,
      );
    }
    if (year >= recentYearBoundary || prior.sourceWindowState !== "closed") {
      return {
        year,
        partitionId: clermontPartitionId(year),
        action: "recent-year" as const,
        expectedRecords: expectedByYear.get(year) ?? 0,
        stableIds: [],
      };
    }
    if (prior.openPermitStableIds.length > 0) {
      return {
        year,
        partitionId: clermontPartitionId(year),
        action: "open-records" as const,
        expectedRecords: prior.openPermitStableIds.length,
        stableIds: [...prior.openPermitStableIds],
      };
    }
    return {
      year,
      partitionId: clermontPartitionId(year),
      action: "reuse-immutable" as const,
      expectedRecords: 0,
      stableIds: [],
    };
  });

  return {
    basis: "execution",
    mode: request.refreshMode,
    recentYearBoundary,
    baselineSha256: baseline === null ? null : clermontBaselineDigest(baseline),
    partitions,
  };
}

export function buildClermontCostBoundingPlan(
  requestValue: ClermontRunRequest,
): ClermontRefreshPlan {
  const request = clermontRunRequestSchema.parse(requestValue);
  const expectedByYear = new Map(
    request.benchmark.expectedByYear.map(({ year, expectedRecords }) => [year, expectedRecords]),
  );
  return {
    basis: "conservative-cost-bound",
    mode: request.refreshMode,
    recentYearBoundary: request.asOfYear - 1,
    baselineSha256: request.baseline.requiredSha256,
    partitions: CLERMONT_PERMIT_YEARS.map((year) => ({
      year,
      partitionId: clermontPartitionId(year),
      action: "full-year",
      expectedRecords: expectedByYear.get(year) ?? 0,
      stableIds: [],
    })),
  };
}

export function estimateClermontRun(
  requestValue: ClermontRunRequest,
  refreshPlan: ClermontRefreshPlan,
): ClermontCostEstimate {
  const request = clermontRunRequestSchema.parse(requestValue);
  const expectedRecords = refreshPlan.partitions.reduce(
    (sum, partition) => sum + partition.expectedRecords,
    0,
  );
  const retryMultiplier = 1 + request.benchmark.observedErrorRate;
  const estimatedHours = rounded(
    (expectedRecords / request.benchmark.terminalRecordsPerHour) * retryMultiplier,
  );
  // One list/enumeration request and one detail request per expected terminal
  // record is deliberately conservative for a prefix-partitioned source.
  const expectedRequests = Math.ceil(expectedRecords * 2 * retryMultiplier);
  const expectedRawBytes = expectedRecords * request.benchmark.averageRawBytesPerRecord;
  const estimatedCostUsd = rounded(
    estimatedHours * request.limits.runnerHourlyUsd +
      (expectedRequests / 1_000) * request.limits.requestCostPerThousandUsd +
      (expectedRawBytes / 1024 ** 3) * request.limits.storagePerGbUsd,
  );
  const authorizationReasons: ClermontCostEstimate["authorizationReasons"] = [];
  if (estimatedHours > request.limits.maxAutomaticHours) {
    authorizationReasons.push("duration");
  }
  if (estimatedCostUsd > request.limits.costCeilingUsd) {
    authorizationReasons.push("cost");
  }
  const unsigned: Omit<ClermontCostEstimate, "estimateSha256"> = {
    schemaVersion: CLERMONT_COST_ESTIMATE_SCHEMA_VERSION,
    expectedRecords,
    expectedRequests,
    expectedRawBytes,
    estimatedHours,
    estimatedCostUsd,
    costCeilingUsd: request.limits.costCeilingUsd,
    maxAutomaticHours: request.limits.maxAutomaticHours,
    safeConcurrency: request.benchmark.safeConcurrency,
    requiresManualAuthorization: authorizationReasons.length > 0,
    authorizationReasons,
  };
  return {
    ...unsigned,
    estimateSha256: sha256Text(canonicalJson(unsigned)),
  };
}

export function hasValidEstimateAuthorization(options: {
  request: ClermontRunRequest;
  estimate: ClermontCostEstimate;
  now: string;
}): boolean {
  if (!options.estimate.requiresManualAuthorization) return true;
  const authorization = options.request.authorization;
  if (authorization === null) return false;
  const nowMs = Date.parse(options.now);
  return (
    Number.isFinite(nowMs) &&
    authorization.estimateSha256 === options.estimate.estimateSha256 &&
    Date.parse(authorization.approvedAt) <= nowMs &&
    Date.parse(authorization.expiresAt) > nowMs
  );
}

export function evaluateClermontCostGate(options: { request: ClermontRunRequest; now: string }): {
  estimate: ClermontCostEstimate;
  boundingPlan: ClermontRefreshPlan;
  authorized: boolean;
} {
  const request = clermontRunRequestSchema.parse(options.request);
  const boundingPlan = buildClermontCostBoundingPlan(request);
  const estimate = estimateClermontRun(request, boundingPlan);
  return {
    estimate,
    boundingPlan,
    authorized: hasValidEstimateAuthorization({
      request,
      estimate,
      now: options.now,
    }),
  };
}

function newStageState(
  status: ClermontStageStatus,
  now: string,
  evidenceSha256: string | null = null,
): ClermontStageState {
  return { status, attempt: 0, evidenceSha256, updatedAt: now };
}

export function prepareClermontCoordinator(options: {
  request: ClermontRunRequest;
  baseline: ClermontCertifiedBaseline | null;
  now: string;
}): ClermontCoordinatorState {
  const request = clermontRunRequestSchema.parse(options.request);
  // Cost prediction is deliberately first and uses the full requested source
  // boundary. No baseline artifact needs to be opened to calculate it.
  const costGate = evaluateClermontCostGate({ request, now: options.now });
  const requestSha256 = sha256Text(canonicalJson(request));
  const pendingProvenanceSha256 = sha256Text(
    canonicalJson({ signatures: request.signatures, baseline: request.baseline.requiredSha256 }),
  );
  if (!costGate.authorized) {
    const stages = Object.fromEntries(
      (Object.keys(CLERMONT_STAGE_DEPENDENCIES) as ClermontStageName[]).map((stage) => [
        stage,
        newStageState("pending", options.now),
      ]),
    ) as Record<ClermontStageName, ClermontStageState>;
    stages["cost-prediction"] = newStageState(
      "waiting_human",
      options.now,
      costGate.estimate.estimateSha256,
    );
    return {
      schemaVersion: CLERMONT_COORDINATOR_SCHEMA_VERSION,
      revision: 1,
      runId: request.runId,
      state: "WAITING_HUMAN",
      requestSha256,
      provenanceSha256: pendingProvenanceSha256,
      estimate: costGate.estimate,
      refreshPlan: costGate.boundingPlan,
      stages,
      nextAutomaticTransition: null,
    };
  }
  const baseline = requireCompatibleBaseline({
    request,
    baseline: options.baseline,
    now: options.now,
  });
  const refreshPlan = buildClermontRefreshPlan({ request, baseline });
  const provenanceSha256 = sha256Text(
    canonicalJson({ signatures: request.signatures, baseline: refreshPlan.baselineSha256 }),
  );
  const completedDigest = sha256Text(canonicalJson({ requestSha256, estimate: costGate.estimate }));
  const stages = Object.fromEntries(
    (Object.keys(CLERMONT_STAGE_DEPENDENCIES) as ClermontStageName[]).map((stage) => [
      stage,
      newStageState("pending", options.now),
    ]),
  ) as Record<ClermontStageName, ClermontStageState>;

  stages["cost-prediction"] = newStageState(
    "complete",
    options.now,
    costGate.estimate.estimateSha256,
  );
  stages["baseline-validation"] = newStageState(
    "complete",
    options.now,
    refreshPlan.baselineSha256 ?? sha256Text("full-refresh-without-baseline"),
  );
  stages["refresh-planning"] = newStageState("complete", options.now, completedDigest);
  stages.enumeration = newStageState("ready", options.now);

  return {
    schemaVersion: CLERMONT_COORDINATOR_SCHEMA_VERSION,
    revision: 1,
    runId: request.runId,
    state: "READY",
    requestSha256,
    provenanceSha256,
    estimate: costGate.estimate,
    refreshPlan,
    stages,
    nextAutomaticTransition: "enumeration",
  };
}

function assertStageDependenciesComplete(
  state: ClermontCoordinatorState,
  stage: ClermontStageName,
): void {
  const incomplete = CLERMONT_STAGE_DEPENDENCIES[stage].filter(
    (dependency) => state.stages[dependency].status !== "complete",
  );
  if (incomplete.length > 0) {
    throw new Error(
      `Stage ${stage} is blocked by incomplete dependencies: ${incomplete.join(", ")}`,
    );
  }
}

function nextReadyStage(
  stages: Record<ClermontStageName, ClermontStageState>,
): ClermontStageName | null {
  for (const stage of Object.keys(CLERMONT_STAGE_DEPENDENCIES) as ClermontStageName[]) {
    if (
      stages[stage].status === "pending" &&
      CLERMONT_STAGE_DEPENDENCIES[stage].every(
        (dependency) => stages[dependency].status === "complete",
      )
    ) {
      return stage;
    }
    if (stages[stage].status === "ready") return stage;
  }
  return null;
}

export function startClermontStage(
  state: ClermontCoordinatorState,
  stage: ClermontStageName,
  now: string,
): ClermontCoordinatorState {
  assertStageDependenciesComplete(state, stage);
  if (
    !(["ready", "pending", "cooling_down"] as ClermontStageStatus[]).includes(
      state.stages[stage].status,
    )
  ) {
    throw new Error(`Stage ${stage} is not startable from ${state.stages[stage].status}`);
  }
  const stages = structuredClone(state.stages);
  stages[stage] = {
    ...stages[stage],
    status: "running",
    attempt: stages[stage].attempt + 1,
    updatedAt: now,
  };
  return {
    ...state,
    revision: state.revision + 1,
    state: "RUNNING",
    stages,
    nextAutomaticTransition: null,
  };
}

export function completeClermontStage(
  state: ClermontCoordinatorState,
  stage: ClermontStageName,
  evidenceSha256: string,
  now: string,
): ClermontCoordinatorState {
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) {
    throw new Error("Stage evidence digest must be a SHA-256 hex digest");
  }
  if (state.stages[stage].status !== "running") {
    throw new Error(`Stage ${stage} is not running`);
  }
  const stages = structuredClone(state.stages);
  stages[stage] = {
    ...stages[stage],
    status: "complete",
    evidenceSha256,
    updatedAt: now,
  };
  const next = nextReadyStage(stages);
  if (next !== null && stages[next].status === "pending") {
    stages[next] = { ...stages[next], status: "ready", updatedAt: now };
  }
  const complete = stages["publication-readiness"].status === "complete";
  return {
    ...state,
    revision: state.revision + 1,
    state: complete ? "COMPLETE" : "READY",
    stages,
    nextAutomaticTransition: complete ? null : next,
  };
}

export function deferClermontStage(
  state: ClermontCoordinatorState,
  stage: ClermontStageName,
  status: "cooling_down" | "failed_exhausted",
  evidenceSha256: string,
  now: string,
): ClermontCoordinatorState {
  if (state.stages[stage].status !== "running") {
    throw new Error(`Stage ${stage} is not running`);
  }
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) {
    throw new Error("Stage evidence digest must be a SHA-256 hex digest");
  }
  const stages = structuredClone(state.stages);
  stages[stage] = { ...stages[stage], status, evidenceSha256, updatedAt: now };
  return {
    ...state,
    revision: state.revision + 1,
    state: status === "failed_exhausted" ? "FAILED_EXHAUSTED" : "READY",
    stages,
    nextAutomaticTransition: status === "failed_exhausted" ? null : stage,
  };
}

export function reconcileClermontPartitionRecords(values: unknown[]): {
  counts: ClermontPartitionCounts;
  stableIdsSha256: string;
  openPermitStableIds: string[];
} {
  const records = values.map((value) => clermontRecordEvidenceSchema.parse(value));
  const ids = records.map(({ stableId }) => stableId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Clermont partition contains duplicate stable permit IDs");
  }
  const completed = records.filter(({ disposition }) => disposition === "completed");
  const provenDead = records.filter(({ disposition }) => disposition === "proven-dead");
  const retryablePending = records.filter(({ disposition }) => disposition === "retryable-pending");
  const openPermitStableIds = completed
    .filter(({ open }) => open)
    .map(({ stableId }) => stableId)
    .sort();
  const counts = {
    enumerated: records.length,
    completed: completed.length,
    provenDead: provenDead.length,
    retryablePending: retryablePending.length,
    linked: completed.filter(({ linkage }) => linkage === "linked").length,
    validUnlinked: completed.filter(({ linkage }) => linkage === "valid-unlinked").length,
    withContractor: completed.filter(({ contractorPresent }) => contractorPresent).length,
    withLicense: completed.filter(({ licensePresent }) => licensePresent).length,
    open: openPermitStableIds.length,
    rawEvidence: records.filter(({ rawSha256 }) => rawSha256 !== null).length,
    extractedEvidence: completed.length,
    statusEvidence: records.length,
  } satisfies ClermontPartitionCounts;
  return {
    counts,
    stableIdsSha256: sha256Text(canonicalJson([...ids].sort())),
    openPermitStableIds,
  };
}

export interface ClermontWorkerState {
  partitionId: string;
  status: "idle" | "running" | "cooling_down" | "failed_exhausted";
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  fencingToken: number;
  attempts: number;
  consecutiveFailures: number;
  circuit: "closed" | "open" | "half_open";
  nextAttemptAt: string | null;
  checkpointSha256: string | null;
  signatures: ClermontSignatureSet;
}

export function createClermontWorkerState(
  year: number,
  signatures: ClermontSignatureSet,
): ClermontWorkerState {
  return {
    partitionId: clermontPartitionId(year),
    status: "idle",
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    fencingToken: 0,
    attempts: 0,
    consecutiveFailures: 0,
    circuit: "closed",
    nextAttemptAt: null,
    checkpointSha256: null,
    signatures: structuredClone(signatures),
  };
}

function deterministicJitter(partitionId: string, attempt: number): number {
  const value = Number.parseInt(sha256Text(`${partitionId}:${attempt}`).slice(0, 8), 16);
  return 0.75 + (value / 0xffffffff) * 0.5;
}

function backoffMs(state: ClermontWorkerState, request: ClermontRunRequest): number {
  const exponential = Math.min(
    request.limits.maxBackoffMs,
    request.limits.baseBackoffMs * 2 ** Math.max(0, state.attempts - 1),
  );
  return Math.min(
    request.limits.maxBackoffMs,
    Math.round(exponential * deterministicJitter(state.partitionId, state.attempts)),
  );
}

export function acquireClermontWorkerLease(options: {
  worker: ClermontWorkerState;
  request: ClermontRunRequest;
  owner: string;
  now: string;
}): ClermontWorkerState {
  const request = clermontRunRequestSchema.parse(options.request);
  assertExactSignatures(options.worker.signatures, request.signatures);
  const nowMs = Date.parse(options.now);
  const leaseLive =
    options.worker.leaseExpiresAt !== null && Date.parse(options.worker.leaseExpiresAt) > nowMs;
  if (leaseLive) throw new Error("Partition already has an unexpired lease");
  if (options.worker.status === "failed_exhausted") {
    throw new Error("Worker retry budget is exhausted");
  }
  if (options.worker.nextAttemptAt !== null && Date.parse(options.worker.nextAttemptAt) > nowMs) {
    throw new Error("Worker is in a valid cooldown");
  }
  const recovering = options.worker.circuit === "open";
  return {
    ...options.worker,
    status: "running",
    leaseOwner: options.owner,
    leaseExpiresAt: new Date(nowMs + request.limits.leaseDurationMs).toISOString(),
    heartbeatAt: options.now,
    fencingToken: options.worker.fencingToken + 1,
    attempts: options.worker.attempts + 1,
    circuit: recovering ? "half_open" : "closed",
    nextAttemptAt: null,
  };
}

function assertLease(
  worker: ClermontWorkerState,
  owner: string,
  fencingToken: number,
  now: string,
): void {
  if (
    worker.status !== "running" ||
    worker.leaseOwner !== owner ||
    worker.fencingToken !== fencingToken
  ) {
    throw new Error("Worker lease owner or fencing token is stale");
  }
  if (worker.leaseExpiresAt === null || Date.parse(worker.leaseExpiresAt) <= Date.parse(now)) {
    throw new Error("Worker lease has expired");
  }
}

export function heartbeatClermontWorker(options: {
  worker: ClermontWorkerState;
  request: ClermontRunRequest;
  owner: string;
  fencingToken: number;
  checkpointSha256: string;
  checkpointSignatures: ClermontSignatureSet;
  now: string;
}): ClermontWorkerState {
  const request = clermontRunRequestSchema.parse(options.request);
  assertLease(options.worker, options.owner, options.fencingToken, options.now);
  assertExactSignatures(options.checkpointSignatures, request.signatures);
  if (!/^[a-f0-9]{64}$/.test(options.checkpointSha256)) {
    throw new Error("Checkpoint digest must be a SHA-256 hex digest");
  }
  const nowMs = Date.parse(options.now);
  return {
    ...options.worker,
    heartbeatAt: options.now,
    leaseExpiresAt: new Date(nowMs + request.limits.leaseDurationMs).toISOString(),
    checkpointSha256: options.checkpointSha256,
  };
}

export function failClermontWorkerAttempt(options: {
  worker: ClermontWorkerState;
  request: ClermontRunRequest;
  owner: string;
  fencingToken: number;
  now: string;
}): ClermontWorkerState {
  const request = clermontRunRequestSchema.parse(options.request);
  assertLease(options.worker, options.owner, options.fencingToken, options.now);
  const consecutiveFailures = options.worker.consecutiveFailures + 1;
  const exhausted = options.worker.attempts >= request.limits.maxAttempts;
  const circuitOpen = exhausted || consecutiveFailures >= request.limits.circuitBreakerFailures;
  const delayMs = backoffMs(options.worker, request);
  return {
    ...options.worker,
    status: exhausted ? "failed_exhausted" : "cooling_down",
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: options.now,
    consecutiveFailures,
    circuit: circuitOpen ? "open" : "closed",
    nextAttemptAt: exhausted ? null : new Date(Date.parse(options.now) + delayMs).toISOString(),
  };
}

export function completeClermontWorkerAttempt(options: {
  worker: ClermontWorkerState;
  owner: string;
  fencingToken: number;
  now: string;
}): ClermontWorkerState {
  assertLease(options.worker, options.owner, options.fencingToken, options.now);
  return {
    ...options.worker,
    status: "idle",
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: options.now,
    consecutiveFailures: 0,
    circuit: "closed",
    nextAttemptAt: null,
  };
}

export function assertPartitionCanComplete(options: {
  counts: ClermontPartitionCounts;
  cappedOrTruncated: boolean;
}): void {
  if (options.cappedOrTruncated) {
    throw new Error("Capped or truncated Clermont enumeration cannot complete");
  }
  if (options.counts.retryablePending !== 0) {
    throw new Error("Retryable Clermont records remain pending");
  }
}

export function recordEvidence(record: ClermontRecordEvidence): ClermontRecordEvidence {
  return clermontRecordEvidenceSchema.parse(record);
}
