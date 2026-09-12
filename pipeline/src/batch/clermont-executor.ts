import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";

import { z } from "zod";

import { canonicalJson, sha256Text } from "./contracts.js";
import {
  CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION,
  CLERMONT_PERMIT_YEARS,
  clermontPartitionHandoffSchema,
  clermontRecordEvidenceSchema,
  type ClermontCertifiedBaseline,
  type ClermontImmutableArtifact,
  type ClermontPartitionHandoff,
  type ClermontRecordEvidence,
} from "./clermont-contracts.js";
import {
  acquireClermontWorkerLease,
  completeClermontWorkerAttempt,
  buildClermontRefreshPlan,
  clermontEnumerationPrefixBound,
  completeClermontStage,
  deferClermontStage,
  evaluateClermontCostGate,
  failClermontWorkerAttempt,
  heartbeatClermontWorker,
  reconcileClermontPartitionRecords,
  startClermontStage,
  type ClermontStageName,
  type ClermontWorkerState,
} from "./clermont-coordinator.js";
import { loadLastGoodClermontBaseline } from "./clermont-baseline-store.js";
import { verifyClermontPreparedScopes } from "./clermont-preparation.js";
import {
  acquireClermontRunLock,
  clermontRunDirectory,
  loadClermontCoordinator,
  loadClermontPreparedRun,
  loadClermontWorker,
  updateClermontWorker,
  updateClermontCoordinator,
  withClermontWorkerFence,
  writeFencedClermontRunArtifact,
  writeClermontRunArtifact,
} from "./clermont-run-store.js";

const OPEN_STATUSES = new Set([
  "ISSUED",
  "APPROVED",
  "APPROVED PENDING",
  "IN REVIEW",
  "PENDING INFORMATION",
]);
const MAX_HARVESTER_TERMINATION_GRACE_MS = 60_000;

const permitIndexRowSchema = z
  .object({
    permitNumber: z.string().min(1),
    alternateKey: z.string().nullable().optional(),
  })
  .passthrough();

const permitIndexSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-permit-index.v1"),
    jobId: z.string().min(1),
    jurisdictionKey: z.literal("clermont"),
    sourceUrl: z.literal("https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx"),
    years: z.array(z.string().regex(/^\d{2}$/)).length(1),
    prefixesSearched: z.number().int().nonnegative(),
    unresolvedPrefixes: z.array(z.string()),
    permitCount: z.number().int().nonnegative(),
    permits: z.array(permitIndexRowSchema),
  })
  .passthrough()
  .superRefine((index, context) => {
    if (index.permitCount !== index.permits.length) {
      context.addIssue({ code: "custom", message: "Permit index count does not match its rows" });
    }
    const numbers = index.permits.map(({ permitNumber }) => permitNumber);
    if (new Set(numbers).size !== numbers.length) {
      context.addIssue({ code: "custom", message: "Permit index contains duplicate numbers" });
    }
    if (numbers.some((number) => !number.startsWith(`${index.years[0]}-`))) {
      context.addIssue({
        code: "custom",
        message: "Permit index crosses its requested year boundary",
      });
    }
  });

const terminalDeadErrorCodeSchema = z.enum(["source_record_not_found", "source_record_gone"]);
const deadAttemptEvidenceSchema = z
  .object({
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    observedAt: z.string().datetime({ offset: true }),
    requestUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:"),
    requestMethod: z.literal("GET"),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    responseSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    classification: z.enum(["transient", "permanent"]),
    errorCode: z.string().min(1),
  })
  .strict();

const permanentDeadEvidenceSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-permanent-dead-evidence.v2"),
    permitNumber: z.string().min(1),
    alternateKey: z.string().nullable(),
    classification: z.literal("permanent"),
    errorCode: terminalDeadErrorCodeSchema,
    message: z.string().min(1),
    observedAt: z.string().datetime({ offset: true }),
    attempts: z.array(deadAttemptEvidenceSchema).min(1),
    sourceProof: z
      .object({
        requestUrl: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:"),
        requestMethod: z.literal("GET"),
        httpStatus: z.union([z.literal(404), z.literal(410)]),
        responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
        responseBody: z.string(),
        observedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    searchRow: permitIndexRowSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const expectedRequestUrl = `https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=${encodeURIComponent(
      evidence.permitNumber,
    )}`;
    const expectedCode =
      evidence.sourceProof.httpStatus === 404 ? "source_record_not_found" : "source_record_gone";
    if (evidence.errorCode !== expectedCode) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Permanent-dead code must match its terminal HTTP status",
      });
    }
    if (evidence.sourceProof.responseSha256 !== sha256Text(evidence.sourceProof.responseBody)) {
      context.addIssue({
        code: "custom",
        path: ["sourceProof", "responseSha256"],
        message: "Permanent-dead source proof digest does not match its retained body",
      });
    }
    if (evidence.sourceProof.requestUrl !== expectedRequestUrl) {
      context.addIssue({
        code: "custom",
        path: ["sourceProof", "requestUrl"],
        message: "Permanent-dead proof URL must identify the exact enumerated permit",
      });
    }
    const lastAttempt = evidence.attempts.at(-1);
    const declaredMaximum = evidence.attempts[0]?.maxAttempts;
    if (
      evidence.attempts.length > (declaredMaximum ?? 0) ||
      evidence.attempts.some(
        (attempt, index) =>
          attempt.attempt !== index + 1 ||
          attempt.maxAttempts !== declaredMaximum ||
          attempt.requestUrl !== evidence.sourceProof.requestUrl ||
          (index < evidence.attempts.length - 1 && attempt.classification !== "transient"),
      ) ||
      lastAttempt?.classification !== "permanent" ||
      lastAttempt.errorCode !== evidence.errorCode ||
      lastAttempt.httpStatus !== evidence.sourceProof.httpStatus ||
      lastAttempt.responseSha256 !== evidence.sourceProof.responseSha256 ||
      lastAttempt.observedAt !== evidence.sourceProof.observedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "Ordered attempts must end in the retained terminal source proof",
      });
    }
  });

const licenseDirectoryMetaSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-license-directory-provenance.v1"),
    jobId: z.string().min(1),
    sourceUrl: z.literal("https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx"),
    capturedAt: z.string().datetime({ offset: true }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.number().int().nonnegative(),
    validityBoundary: z.literal(
      "contractor-registration-at-capture-not-historical-license-validity",
    ),
  })
  .strict();

const executionCostAuthorizationSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-execution-cost-authorization.v2"),
    authorizationId: z.string().regex(/^[a-z0-9][a-z0-9-]{15,119}$/),
    runId: z.string().min(8).max(120),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    provenanceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    estimateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    approvalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    consumedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const executionBudgetSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-execution-budget.v1"),
    runId: z.string().min(8).max(120),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    provenanceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    estimateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.string().datetime({ offset: true }),
    deadlineAt: z.string().datetime({ offset: true }),
    maximumExecutionHours: z.number().positive().finite(),
    maximumCostUsd: z.number().positive().finite(),
  })
  .strict()
  .superRefine((budget, context) => {
    const expectedDeadline = new Date(
      Date.parse(budget.startedAt) + budget.maximumExecutionHours * 60 * 60 * 1_000,
    ).toISOString();
    if (budget.deadlineAt !== expectedDeadline) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "Execution deadline must match the exact approved wall-time budget",
      });
    }
  });

const PRUNABLE_EVIDENCE_DIRECTORIES = ["raw", "extracted", "status", "dead"] as const;
const pruneReceiptSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-loose-evidence-prune.v1"),
    runId: z.string().min(8).max(120),
    year: z.number().int().min(2015).max(2026),
    status: z.enum(["quarantining", "quarantined", "deleted"]),
    updatedAt: z.string().datetime({ offset: true }),
    quarantineRelativePath: z.string().regex(/^\.pruned\/fence-[1-9][0-9]*$/),
    plannedDirectories: z.array(z.enum(PRUNABLE_EVIDENCE_DIRECTORIES)).length(4),
    producerLease: z
      .object({
        owner: z.string().min(1).max(200),
        fencingToken: z.number().int().positive(),
        heartbeatAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    recoveredBy: z
      .object({ owner: z.string().min(1).max(200), fencingToken: z.number().int().positive() })
      .strict()
      .nullable(),
    handoffSha256: z.string().regex(/^[a-f0-9]{64}$/),
    artifactsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function safeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteExternalJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

async function writeOnceExternalJson(
  filePath: string,
  value: unknown,
  assertOwned: () => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const encoded = `${canonicalJson(value)}\n`;
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx" });
    await assertOwned();
    await link(temporary, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(filePath, "utf8")) !== encoded) {
      throw new Error(
        `Immutable execution artifact already exists with different bytes: ${filePath}`,
      );
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeOnceExternalText(
  filePath: string,
  encoded: string,
  assertOwned: () => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx" });
    await assertOwned();
    await link(temporary, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(filePath, "utf8")) !== encoded) {
      throw new Error(
        `Immutable execution artifact already exists with different bytes: ${filePath}`,
      );
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function immutableArtifact(
  root: string,
  filePath: string,
): Promise<ClermontImmutableArtifact> {
  const fileStat = await stat(filePath);
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  return { logicalPath: relative, sha256: await sha256File(filePath), bytes: fileStat.size };
}

async function writeDeterministicGzipNdjson(options: {
  candidateRoot: string;
  outputPath: string;
  values: Iterable<unknown> | AsyncIterable<unknown>;
  expectedCount: number;
  guard: ClermontLeaseGuard;
}): Promise<ClermontImmutableArtifact> {
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const temporary = `${options.outputPath}.${randomUUID()}.tmp`;
  async function* encodedValues(): AsyncGenerator<string> {
    for await (const value of options.values) {
      options.guard.throwIfFailed();
      yield `${canonicalJson(value)}\n`;
    }
  }
  await options.guard.assertActive();
  const source = Readable.from(encodedValues(), { encoding: "utf8" });
  try {
    // Node writes a zero gzip mtime, so identical NDJSON produces identical bytes.
    await pipeline(source, createGzip({ level: 9 }), createWriteStream(temporary, { flags: "wx" }));
    await options.guard.assertActive();
    await rename(temporary, options.outputPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const artifact = await immutableArtifact(options.candidateRoot, options.outputPath);
  const decodedCount = await countEvidenceLines(options.candidateRoot, artifact);
  if (decodedCount !== options.expectedCount) {
    throw new Error(`Archive readback count mismatch for ${artifact.logicalPath}`);
  }
  return artifact;
}

export async function countEvidenceLines(
  root: string,
  artifact: ClermontImmutableArtifact,
): Promise<number> {
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, artifact.logicalPath);
  if (!filePath.startsWith(`${rootPath}${path.sep}`)) throw new Error("Evidence path escapes root");
  const fileStat = await stat(filePath);
  if (fileStat.size !== artifact.bytes || (await sha256File(filePath)) !== artifact.sha256) {
    throw new Error(`Evidence artifact failed digest readback: ${artifact.logicalPath}`);
  }
  const input = createReadStream(filePath);
  const stream = artifact.logicalPath.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.body === "string" && typeof value.sha256 === "string") {
      if (sha256Text(value.body) !== value.sha256) {
        throw new Error(`Embedded evidence digest mismatch in ${artifact.logicalPath}`);
      }
    }
    count += 1;
  }
  return count;
}

export async function readEvidenceLines(
  root: string,
  artifact: ClermontImmutableArtifact,
): Promise<unknown[]> {
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, artifact.logicalPath);
  if (!filePath.startsWith(`${rootPath}${path.sep}`)) throw new Error("Evidence path escapes root");
  const fileStat = await stat(filePath);
  if (fileStat.size !== artifact.bytes || (await sha256File(filePath)) !== artifact.sha256) {
    throw new Error(`Evidence artifact failed digest readback: ${artifact.logicalPath}`);
  }
  const chunks: Buffer[] = [];
  const input = createReadStream(filePath);
  const stream = artifact.logicalPath.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

export interface ClermontHarvesterRunOptions {
  scriptPath: string;
  args: string[];
  logPath: string;
  timeoutMs: number;
  terminationGraceMs: number;
  signal: AbortSignal;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function runClermontHarvesterProcess(
  options: ClermontHarvesterRunOptions,
): Promise<void> {
  if (
    !Number.isInteger(options.terminationGraceMs) ||
    options.terminationGraceMs < 1 ||
    options.terminationGraceMs > MAX_HARVESTER_TERMINATION_GRACE_MS
  ) {
    throw new Error("Harvester termination grace must be between 1ms and 60000ms");
  }
  await mkdir(path.dirname(options.logPath), { recursive: true });
  const output = createWriteStream(options.logPath, { flags: "a" });
  const child = spawn(process.execPath, [options.scriptPath, ...options.args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let terminationError: Error | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let terminationStarted = false;
  const terminate = (error: Error): void => {
    if (terminationStarted) return;
    terminationStarted = true;
    terminationError = error;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, options.terminationGraceMs);
    killTimer.unref();
  };
  const onAbort = () => terminate(asError(options.signal.reason ?? "Lease supervisor aborted"));
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => terminate(new Error(`Clermont harvester timed out after ${options.timeoutMs}ms`)),
    options.timeoutMs,
  );
  timeout.unref();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    clearTimeout(timeout);
    if (killTimer !== null) clearTimeout(killTimer);
    options.signal.removeEventListener("abort", onAbort);
    output.end();
  });
  if (terminationError !== null) throw terminationError;
  if (exit.code !== 0) {
    throw new Error(
      `Clermont harvester failed (code ${String(exit.code)}, signal ${String(exit.signal)}); inspect ${options.logPath}`,
    );
  }
}

export function createElapsedClermontClock(
  startedAt: string,
  monotonicNow: () => number = performance.now.bind(performance),
): () => string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error("Clermont clock start must be ISO-8601");
  const monotonicStartedAtMs = monotonicNow();
  if (!Number.isFinite(monotonicStartedAtMs)) {
    throw new Error("Clermont monotonic clock must be finite");
  }
  let priorMs = startedAtMs;
  return () => {
    const observedMonotonicMs = monotonicNow();
    if (!Number.isFinite(observedMonotonicMs)) {
      throw new Error("Clermont monotonic clock must be finite");
    }
    const elapsedMs = Math.max(0, observedMonotonicMs - monotonicStartedAtMs);
    priorMs = Math.max(priorMs + 1, startedAtMs + Math.floor(elapsedMs));
    return new Date(priorMs).toISOString();
  };
}

function validatedMonotonicClock(clock: () => string): () => string {
  let priorMs = Number.NEGATIVE_INFINITY;
  return () => {
    const value = clock();
    const valueMs = Date.parse(value);
    if (!Number.isFinite(valueMs)) throw new Error("Clermont clock must return ISO-8601");
    if (valueMs < priorMs) throw new Error("Clermont clock cannot move backwards");
    priorMs = valueMs;
    return new Date(valueMs).toISOString();
  };
}

export interface ClermontLeaseSupervisor {
  readonly signal: AbortSignal;
  readonly leaseError: Error | null;
  throwIfFailed(): void;
  setCheckpoint(checkpointSha256: string): void;
  pulse(): Promise<void>;
  assertActive(): Promise<void>;
  guardCommit<T>(task: () => Promise<T>): Promise<T>;
  finish<T>(terminal: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

export function startClermontLeaseSupervisor(options: {
  heartbeatIntervalMs: number;
  initialCheckpointSha256: string;
  heartbeat: (checkpointSha256: string) => Promise<void>;
  parentSignal?: AbortSignal;
}): ClermontLeaseSupervisor {
  let checkpointSha256 = options.initialCheckpointSha256;
  let stopped = false;
  let heartbeatFlight: Promise<void> | null = null;
  let commitFlight: Promise<unknown> | null = null;
  let leaseError: Error | null = null;
  const controller = new AbortController();

  const recordLeaseError = (error: unknown): Error => {
    const normalized = asError(error);
    if (leaseError === null) {
      leaseError = normalized;
      controller.abort(normalized);
    }
    return leaseError;
  };
  const abortFromParent = () => {
    recordLeaseError(options.parentSignal?.reason ?? new Error("Clermont execution was aborted"));
  };
  if (options.parentSignal?.aborted) abortFromParent();
  else options.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const pulse = async (): Promise<void> => {
    if (leaseError !== null) throw leaseError;
    if (stopped) return;
    if (commitFlight !== null) {
      await commitFlight;
      if (leaseError !== null) throw leaseError;
      return;
    }
    if (heartbeatFlight !== null) return heartbeatFlight;
    const flight = options
      .heartbeat(checkpointSha256)
      .catch((error: unknown) => {
        throw recordLeaseError(error);
      })
      .finally(() => {
        if (heartbeatFlight === flight) heartbeatFlight = null;
      });
    heartbeatFlight = flight;
    return flight;
  };
  const guardCommit = async <T>(task: () => Promise<T>): Promise<T> => {
    if (leaseError !== null) throw leaseError;
    if (stopped) throw new Error("Lease supervisor is stopped");
    if (commitFlight !== null) {
      throw new Error("Another fenced Clermont commit is already running");
    }
    const flight = (async (): Promise<T> => {
      if (heartbeatFlight !== null) await heartbeatFlight;
      if (leaseError !== null) throw leaseError;
      await pulseFreshHeartbeat();
      if (leaseError !== null) throw leaseError;
      return task();
    })();
    commitFlight = flight;
    try {
      return await flight;
    } finally {
      if (commitFlight === flight) commitFlight = null;
    }
  };
  const pulseFreshHeartbeat = async (): Promise<void> => {
    if (leaseError !== null) throw leaseError;
    if (heartbeatFlight !== null) await heartbeatFlight;
    if (leaseError !== null) throw leaseError;
    const flight = options
      .heartbeat(checkpointSha256)
      .catch((error: unknown) => {
        throw recordLeaseError(error);
      })
      .finally(() => {
        if (heartbeatFlight === flight) heartbeatFlight = null;
      });
    heartbeatFlight = flight;
    return flight;
  };
  const timer = setInterval(() => {
    void pulse().catch(() => undefined);
  }, options.heartbeatIntervalMs);
  timer.unref();
  const quiesce = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    options.parentSignal?.removeEventListener("abort", abortFromParent);
    if (commitFlight !== null) await commitFlight;
    if (heartbeatFlight !== null) await heartbeatFlight;
    if (leaseError !== null) throw leaseError;
  };

  return {
    signal: controller.signal,
    get leaseError() {
      return leaseError;
    },
    throwIfFailed() {
      if (leaseError !== null) throw leaseError;
    },
    setCheckpoint(value: string) {
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error("Lease supervisor checkpoint must be a SHA-256 digest");
      }
      checkpointSha256 = value;
    },
    pulse,
    guardCommit,
    async assertActive() {
      if (heartbeatFlight !== null) await heartbeatFlight;
      if (leaseError !== null) throw leaseError;
    },
    async finish<T>(terminal: () => Promise<T>) {
      await quiesce();
      return terminal();
    },
    stop: quiesce,
  };
}

export interface ClermontLeaseGuard {
  readonly leaseError: Error | null;
  assertActive(): Promise<void>;
  throwIfFailed(): void;
  guardCommit<T>(task: () => Promise<T>): Promise<T>;
}

function livePartitionJobId(runId: string, year: number): string {
  return `${runId}-y${year}`;
}

export function clermontLivePartitionRoot(
  repoRoot: string,
  runId: string,
  year: number,
  artifactsRoot?: string,
): string {
  const root = artifactsRoot ?? path.join(repoRoot, "pipeline", "data", "artifacts");
  return path.join(root, "permits", "lake", livePartitionJobId(runId, year));
}

function stableId(permitNumber: string): string {
  return `lake:clermont:etrakit:${permitNumber}`;
}

interface NormalizedPermitSchema {
  parse(value: unknown): Record<string, unknown>;
}

async function parseNormalizedClermontRecord(value: unknown): Promise<Record<string, unknown>> {
  const contractUrl = new URL("../permits/contracts.mjs", import.meta.url).href;
  const contracts = (await import(contractUrl)) as {
    normalizedPermitRecordSchema: NormalizedPermitSchema;
  };
  return contracts.normalizedPermitRecordSchema.parse(value);
}

async function countLicenseDirectoryEntries(html: string): Promise<number> {
  const adapterUrl = new URL("../counties/lake/etrakit-adapter.mjs", import.meta.url).href;
  const adapter = (await import(adapterUrl)) as {
    licenseIndexFromSearchPage(value: string): Map<string, string>;
  };
  return adapter.licenseIndexFromSearchPage(html).size;
}

async function assertPinnedLicenseNormalization(
  record: Record<string, unknown>,
  licenseDirectoryHtml: string,
): Promise<void> {
  const adapterUrl = new URL("../counties/lake/etrakit-adapter.mjs", import.meta.url).href;
  const normalizerUrl = new URL("../counties/lake/clermont-permits.mjs", import.meta.url).href;
  const adapter = (await import(adapterUrl)) as {
    licenseIndexFromSearchPage(value: string): Map<string, string>;
  };
  const normalizer = (await import(normalizerUrl)) as {
    contractorMatchKey(value: string): string;
    licenseFromName(value: string): string | null;
  };
  const index = adapter.licenseIndexFromSearchPage(licenseDirectoryHtml);
  const expectedLicense = (name: string): string | null =>
    normalizer.licenseFromName(name) ?? index.get(normalizer.contractorMatchKey(name)) ?? null;
  for (const contractor of record.contractors as Array<Record<string, unknown>>) {
    const businessName = String(contractor.businessName);
    if ((contractor.licenseNumber ?? null) !== expectedLicense(businessName)) {
      throw new Error(`Contractor ${businessName} was not normalized against the pinned directory`);
    }
  }
  const sourcePayload = record.sourcePayload as Record<string, unknown>;
  const contractorOfRecord = sourcePayload.contractorOfRecord;
  const expectedOfRecordLicense =
    typeof contractorOfRecord === "string" ? expectedLicense(contractorOfRecord) : null;
  if ((sourcePayload.contractorOfRecordLicense ?? null) !== expectedOfRecordLicense) {
    throw new Error("Contractor of record was not normalized against the pinned directory");
  }
}

async function readImmutableArtifactText(
  root: string,
  artifact: ClermontImmutableArtifact,
): Promise<string> {
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, artifact.logicalPath);
  if (!filePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("Evidence path escapes root");
  }
  const [fileStat, body] = await Promise.all([stat(filePath), readFile(filePath, "utf8")]);
  if (fileStat.size !== artifact.bytes || sha256Text(body) !== artifact.sha256) {
    throw new Error(`Evidence artifact failed digest readback: ${artifact.logicalPath}`);
  }
  return body;
}

const rawEvidenceWrapperSchema = z
  .object({
    stableId: z.string().regex(/^lake:clermont:etrakit:[A-Za-z0-9._:/-]+$/),
    mediaType: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    body: z.string(),
  })
  .strict();

const extractedEvidenceWrapperSchema = z
  .object({
    stableId: z.string().regex(/^lake:clermont:etrakit:[A-Za-z0-9._:/-]+$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    body: z.string(),
  })
  .strict();

export async function verifyClermontEvidenceCorrelation(options: {
  candidateRoot: string;
  handoff: ClermontPartitionHandoff;
}): Promise<{
  statusRecords: ClermontRecordEvidence[];
  rawCount: number;
  extractedCount: number;
}> {
  const [rawValues, extractedValues, statusValues] = await Promise.all([
    readEvidenceLines(options.candidateRoot, options.handoff.artifacts.raw),
    readEvidenceLines(options.candidateRoot, options.handoff.artifacts.extracted),
    readEvidenceLines(options.candidateRoot, options.handoff.artifacts.status),
  ]);
  const licenseDirectory = await readImmutableArtifactText(
    options.candidateRoot,
    options.handoff.artifacts.licenseDirectory,
  );
  if (
    sha256Text(licenseDirectory) !== options.handoff.licenseDirectory.sha256 ||
    (await countLicenseDirectoryEntries(licenseDirectory)) !==
      options.handoff.licenseDirectory.entries
  ) {
    throw new Error(`License-directory evidence does not match year ${options.handoff.year}`);
  }
  const rawByStableId = new Map<string, z.infer<typeof rawEvidenceWrapperSchema>>();
  for (const value of rawValues) {
    const wrapper = rawEvidenceWrapperSchema.parse(value);
    if (rawByStableId.has(wrapper.stableId)) {
      throw new Error(`Duplicate raw wrapper for ${wrapper.stableId}`);
    }
    if (sha256Text(wrapper.body) !== wrapper.sha256) {
      throw new Error(`Raw wrapper digest mismatch for ${wrapper.stableId}`);
    }
    rawByStableId.set(wrapper.stableId, wrapper);
  }
  const extractedByStableId = new Map<string, z.infer<typeof extractedEvidenceWrapperSchema>>();
  for (const value of extractedValues) {
    const wrapper = extractedEvidenceWrapperSchema.parse(value);
    if (extractedByStableId.has(wrapper.stableId)) {
      throw new Error(`Duplicate extracted wrapper for ${wrapper.stableId}`);
    }
    if (sha256Text(wrapper.body) !== wrapper.sha256) {
      throw new Error(`Extracted wrapper digest mismatch for ${wrapper.stableId}`);
    }
    const record = await parseNormalizedClermontRecord(JSON.parse(wrapper.body));
    if (stableId(String(record.permit_number ?? "")) !== wrapper.stableId) {
      throw new Error(`Extracted permit identity mismatch for ${wrapper.stableId}`);
    }
    extractedByStableId.set(wrapper.stableId, wrapper);
  }
  const statusRecords = statusValues.map((value) => clermontRecordEvidenceSchema.parse(value));
  for (const record of statusRecords) {
    const { statusSha256, ...payload } = record;
    if (statusSha256 !== sha256Text(canonicalJson(payload))) {
      throw new Error(`Status evidence digest mismatch for ${record.stableId}`);
    }
    const raw = rawByStableId.get(record.stableId);
    const extracted = extractedByStableId.get(record.stableId);
    if (
      (record.rawSha256 === null ? raw !== undefined : raw?.sha256 !== record.rawSha256) ||
      (record.extractedSha256 === null
        ? extracted !== undefined
        : extracted?.sha256 !== record.extractedSha256)
    ) {
      throw new Error(`Status evidence does not bind raw/extracted bytes for ${record.stableId}`);
    }
    if (record.disposition === "proven-dead") {
      if (raw?.mediaType !== "application/json") {
        throw new Error(`Dead status does not bind diagnostic JSON for ${record.stableId}`);
      }
      const parsedDead = permanentDeadEvidenceSchema.safeParse(JSON.parse(raw.body));
      if (!parsedDead.success || stableId(parsedDead.data.permitNumber) !== record.stableId) {
        throw new Error(`Dead diagnostic identity mismatch for ${record.stableId}`);
      }
      if (
        parsedDead.data.searchRow.permitNumber !== parsedDead.data.permitNumber ||
        (parsedDead.data.searchRow.alternateKey ?? null) !== parsedDead.data.alternateKey
      ) {
        throw new Error(`Dead diagnostic enumeration mismatch for ${record.stableId}`);
      }
    }
  }
  if (
    rawByStableId.size !== statusRecords.filter(({ rawSha256 }) => rawSha256 !== null).length ||
    extractedByStableId.size !==
      statusRecords.filter(({ extractedSha256 }) => extractedSha256 !== null).length
  ) {
    throw new Error("Raw or extracted evidence contains a wrapper absent from status evidence");
  }
  return {
    statusRecords,
    rawCount: rawByStableId.size,
    extractedCount: extractedByStableId.size,
  };
}

function statusEvidence(options: {
  permitNumber: string;
  disposition: "completed" | "proven-dead" | "retryable-pending";
  record: Record<string, unknown> | null;
  rawSha256: string | null;
  extractedSha256: string | null;
}): ClermontRecordEvidence {
  const completed = options.disposition === "completed";
  const sourcePayload =
    completed && options.record !== null && typeof options.record.sourcePayload === "object"
      ? (options.record.sourcePayload as Record<string, unknown>)
      : {};
  const contractors =
    completed && options.record !== null && Array.isArray(options.record.contractors)
      ? options.record.contractors
      : [];
  const contractorPresent =
    completed && (typeof sourcePayload.contractorOfRecord === "string" || contractors.length > 0);
  const licensePresent =
    completed &&
    (typeof sourcePayload.contractorOfRecordLicense === "string" ||
      contractors.some(
        (contractor) =>
          typeof contractor === "object" &&
          contractor !== null &&
          typeof (contractor as Record<string, unknown>).licenseNumber === "string",
      ));
  const payload = {
    stableId: stableId(options.permitNumber),
    disposition: options.disposition,
    linkage:
      completed && options.record !== null
        ? options.record.property_id === null
          ? "valid-unlinked"
          : "linked"
        : null,
    contractorPresent,
    licensePresent,
    open:
      completed && options.record !== null
        ? OPEN_STATUSES.has(String(options.record.improvement_status ?? "").toUpperCase())
        : false,
    rawSha256: options.rawSha256,
    extractedSha256: options.extractedSha256,
  };
  return clermontRecordEvidenceSchema.parse({
    ...payload,
    statusSha256: sha256Text(canonicalJson(payload)),
  });
}

export async function sealClermontPartitionEvidence(options: {
  repoRoot: string;
  runStore: string;
  runId: string;
  year: number;
  owner: string;
  fencingToken: number;
  clock: () => string;
  guard: ClermontLeaseGuard;
  liveArtifactsRoot?: string;
  pruneLooseAfterSeal?: boolean;
  afterPruneQuarantined?: () => Promise<void>;
}): Promise<ClermontPartitionHandoff> {
  await options.guard.assertActive();
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  const liveRoot = clermontLivePartitionRoot(
    options.repoRoot,
    options.runId,
    options.year,
    options.liveArtifactsRoot,
  );
  const index = permitIndexSchema.parse(
    JSON.parse(
      await readFile(path.join(liveRoot, "permit-lists", "clermont-permit-index.json"), "utf8"),
    ),
  );
  const expectedYear = String(options.year).slice(-2);
  if (
    index.years[0] !== expectedYear ||
    index.jobId !== livePartitionJobId(options.runId, options.year)
  ) {
    throw new Error(`Live partition evidence is not bound to Clermont year ${options.year}`);
  }
  const [licenseDirectoryBody, licenseDirectoryMeta] = await Promise.all([
    readFile(path.join(liveRoot, "license-directory.html"), "utf8"),
    readFile(path.join(liveRoot, "license-directory.meta.json"), "utf8").then((body) =>
      licenseDirectoryMetaSchema.parse(JSON.parse(body)),
    ),
  ]);
  if (
    licenseDirectoryMeta.jobId !== livePartitionJobId(options.runId, options.year) ||
    licenseDirectoryMeta.sha256 !== sha256Text(licenseDirectoryBody) ||
    licenseDirectoryMeta.entries === 0 ||
    (await countLicenseDirectoryEntries(licenseDirectoryBody)) !== licenseDirectoryMeta.entries
  ) {
    throw new Error(
      `License-directory provenance is incompatible with Clermont year ${options.year}`,
    );
  }

  const rawEntries: Array<{ stableId: string; mediaType: string; filePath: string }> = [];
  const extractedEntries: Array<{ stableId: string; filePath: string }> = [];
  const evidence: ClermontRecordEvidence[] = [];
  for (const row of [...index.permits].sort((left, right) =>
    left.permitNumber.localeCompare(right.permitNumber),
  )) {
    options.guard.throwIfFailed();
    const key = safeKeyPart(row.permitNumber);
    const rawPath = path.join(liveRoot, "raw", `${key}.html`);
    const extractedPath = path.join(liveRoot, "extracted", `${key}.json`);
    const deadPath = path.join(liveRoot, "dead", `${key}.json`);
    const hasRaw = await exists(rawPath);
    const hasExtracted = await exists(extractedPath);
    const hasDead = await exists(deadPath);
    if ((hasRaw || hasExtracted) && hasDead) {
      throw new Error(`Permit ${row.permitNumber} has conflicting complete and dead evidence`);
    }
    if (hasRaw && hasExtracted) {
      const [raw, extractedText] = await Promise.all([
        readFile(rawPath, "utf8"),
        readFile(extractedPath, "utf8"),
      ]);
      options.guard.throwIfFailed();
      const record = await parseNormalizedClermontRecord(JSON.parse(extractedText));
      if (record.permit_number !== row.permitNumber) {
        throw new Error(`Extracted permit identity mismatch for ${row.permitNumber}`);
      }
      const sourcePayload = record.sourcePayload;
      if (
        typeof sourcePayload !== "object" ||
        sourcePayload === null ||
        !("licenseDirectorySha256" in sourcePayload) ||
        sourcePayload.licenseDirectorySha256 !== licenseDirectoryMeta.sha256
      ) {
        throw new Error(
          `Extracted permit does not bind the pinned license directory for ${row.permitNumber}`,
        );
      }
      await assertPinnedLicenseNormalization(record, licenseDirectoryBody);
      const rawSha256 = sha256Text(raw);
      const extractedSha256 = sha256Text(extractedText);
      rawEntries.push({
        stableId: stableId(row.permitNumber),
        mediaType: "text/html; charset=utf-8",
        filePath: rawPath,
      });
      extractedEntries.push({
        stableId: stableId(row.permitNumber),
        filePath: extractedPath,
      });
      evidence.push(
        statusEvidence({
          permitNumber: row.permitNumber,
          disposition: "completed",
          record,
          rawSha256,
          extractedSha256,
        }),
      );
    } else if (hasDead) {
      const body = await readFile(deadPath, "utf8");
      const parsedDead = permanentDeadEvidenceSchema.safeParse(JSON.parse(body));
      if (!parsedDead.success) {
        throw new Error(
          `Dead permit evidence is not a permanent source failure for ${row.permitNumber}`,
        );
      }
      const dead = parsedDead.data;
      if (
        dead.permitNumber !== row.permitNumber ||
        dead.alternateKey !== (row.alternateKey ?? null)
      ) {
        throw new Error(`Dead permit identity mismatch for ${row.permitNumber}`);
      }
      if (canonicalJson(dead.searchRow) !== canonicalJson(row)) {
        throw new Error(`Dead permit enumeration row mismatch for ${row.permitNumber}`);
      }
      const rawSha256 = sha256Text(body);
      rawEntries.push({
        stableId: stableId(row.permitNumber),
        mediaType: "application/json",
        filePath: deadPath,
      });
      evidence.push(
        statusEvidence({
          permitNumber: row.permitNumber,
          disposition: "proven-dead",
          record: null,
          rawSha256,
          extractedSha256: null,
        }),
      );
    } else {
      evidence.push(
        statusEvidence({
          permitNumber: row.permitNumber,
          disposition: "retryable-pending",
          record: null,
          rawSha256: null,
          extractedSha256: null,
        }),
      );
    }
  }
  const reconciled = reconcileClermontPartitionRecords(evidence);
  const cappedOrTruncated = index.unresolvedPrefixes.length > 0;
  const terminal = !cappedOrTruncated && reconciled.counts.retryablePending === 0;
  const candidateRoot = path.join(
    clermontRunDirectory(options.runStore, options.runId),
    "candidate",
  );
  const partitionRoot = path.join(
    candidateRoot,
    "partitions",
    String(options.year),
    `fence-${options.fencingToken}`,
  );
  async function* rawLines(): AsyncGenerator<unknown> {
    for (const entry of rawEntries) {
      options.guard.throwIfFailed();
      const body = await readFile(entry.filePath, "utf8");
      options.guard.throwIfFailed();
      yield {
        stableId: entry.stableId,
        mediaType: entry.mediaType,
        sha256: sha256Text(body),
        body,
      };
    }
  }
  async function* extractedLines(): AsyncGenerator<unknown> {
    for (const entry of extractedEntries) {
      options.guard.throwIfFailed();
      const body = await readFile(entry.filePath, "utf8");
      options.guard.throwIfFailed();
      yield { stableId: entry.stableId, sha256: sha256Text(body), body };
    }
  }
  const licenseDirectoryPath = path.join(partitionRoot, "license-directory.html");
  await writeOnceExternalText(licenseDirectoryPath, licenseDirectoryBody, () =>
    options.guard.assertActive(),
  );
  await options.guard.assertActive();
  const artifacts = {
    raw: await writeDeterministicGzipNdjson({
      candidateRoot,
      outputPath: path.join(partitionRoot, "raw.ndjson.gz"),
      values: rawLines(),
      expectedCount: rawEntries.length,
      guard: options.guard,
    }),
    extracted: await writeDeterministicGzipNdjson({
      candidateRoot,
      outputPath: path.join(partitionRoot, "extracted.ndjson.gz"),
      values: extractedLines(),
      expectedCount: extractedEntries.length,
      guard: options.guard,
    }),
    status: await writeDeterministicGzipNdjson({
      candidateRoot,
      outputPath: path.join(partitionRoot, "status.ndjson.gz"),
      values: evidence,
      expectedCount: evidence.length,
      guard: options.guard,
    }),
    licenseDirectory: await immutableArtifact(candidateRoot, licenseDirectoryPath),
  };
  const checkpointPayload = {
    runId: options.runId,
    year: options.year,
    stableIdsSha256: reconciled.stableIdsSha256,
    counts: reconciled.counts,
    cappedOrTruncated,
    artifacts,
    signatures: prepared.request.signatures,
  };
  const partitionId = `lake-clermont-etrakit-${options.year}`;
  let handoff: ClermontPartitionHandoff | null = null;
  await options.guard.guardCommit(() =>
    writeFencedClermontRunArtifact({
      storeRoot: options.runStore,
      runId: options.runId,
      partitionId,
      owner: options.owner,
      fencingToken: options.fencingToken,
      clock: options.clock,
      relativePath: terminal
        ? `candidate/partitions/${options.year}/handoff.json`
        : `candidate/partitions/${options.year}/fence-${options.fencingToken}/nonterminal-handoff.json`,
      value: (worker, handoffAt) => {
        options.guard.throwIfFailed();
        if (worker.heartbeatAt === null) throw new Error("Fenced worker has no heartbeat evidence");
        handoff = clermontPartitionHandoffSchema.parse({
          schemaVersion: CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION,
          runId: options.runId,
          county: "lake",
          jurisdiction: "clermont",
          sourceSystem: "lake_clermont_etrakit_permits",
          producer: "clermont-permit-acquisition",
          intendedConsumer: "clermont-baseline-certifier",
          privacyClassification: "public-record",
          nextStage: "reconciliation",
          year: options.year,
          partitionId,
          createdAt: handoffAt,
          producerLease: {
            owner: options.owner,
            fencingToken: options.fencingToken,
            heartbeatAt: worker.heartbeatAt,
          },
          sourceWindowState: options.year >= 2025 ? "active" : "closed",
          status: terminal ? "captured_complete" : "cooling_down",
          cappedOrTruncated,
          counts: reconciled.counts,
          stableIdsSha256: reconciled.stableIdsSha256,
          openPermitStableIds: reconciled.openPermitStableIds,
          checkpoint: {
            sequence: reconciled.counts.completed + reconciled.counts.provenDead,
            cursor: terminal ? `${options.year}:terminal` : `${options.year}:pending`,
            checkpointSha256: sha256Text(canonicalJson(checkpointPayload)),
            terminal,
            signatures: prepared.request.signatures,
          },
          artifacts,
          licenseDirectory: {
            sourceUrl: licenseDirectoryMeta.sourceUrl,
            capturedAt: licenseDirectoryMeta.capturedAt,
            entries: licenseDirectoryMeta.entries,
            validityBoundary: licenseDirectoryMeta.validityBoundary,
            sha256: licenseDirectoryMeta.sha256,
          },
          signatures: prepared.request.signatures,
        });
        return handoff;
      },
      immutable: true,
    }),
  );
  if (handoff === null) throw new Error("Fenced handoff was not committed");
  const committedHandoff = clermontPartitionHandoffSchema.parse(handoff);
  if (terminal && options.pruneLooseAfterSeal) {
    // The three archives were digest-checked and fully decoded above. Only
    // redundant loose evidence is removed; the index, logs, summaries and
    // immutable archives remain sufficient for replay and certification.
    const quarantineRoot = path.join(liveRoot, ".pruned", `fence-${options.fencingToken}`);
    const quarantineRelativePath = `.pruned/fence-${options.fencingToken}`;
    const receiptPath = path.join(liveRoot, "loose-evidence-pruned.json");
    const handoffSha256 = sha256Text(canonicalJson(committedHandoff));
    const artifactsSha256 = sha256Text(canonicalJson(artifacts));
    const baseReceipt = {
      schemaVersion: "elephant.clermont-loose-evidence-prune.v1",
      runId: options.runId,
      year: options.year,
      quarantineRelativePath,
      plannedDirectories: [...PRUNABLE_EVIDENCE_DIRECTORIES],
      producerLease: {
        owner: options.owner,
        fencingToken: options.fencingToken,
        heartbeatAt: committedHandoff.producerLease.heartbeatAt,
      },
      recoveredBy: null,
      handoffSha256,
      artifactsSha256,
    };
    await options.guard.guardCommit(() =>
      withClermontWorkerFence({
        storeRoot: options.runStore,
        runId: options.runId,
        partitionId,
        owner: options.owner,
        fencingToken: options.fencingToken,
        clock: options.clock,
        task: async (worker, prunedAt) => {
          options.guard.throwIfFailed();
          await atomicWriteExternalJson(
            receiptPath,
            pruneReceiptSchema.parse({
              ...baseReceipt,
              status: "quarantining",
              updatedAt: prunedAt,
              producerLease: {
                owner: options.owner,
                fencingToken: options.fencingToken,
                heartbeatAt: worker.heartbeatAt,
              },
            }),
          );
        },
      }),
    );
    await options.guard.guardCommit(() =>
      withClermontWorkerFence({
        storeRoot: options.runStore,
        runId: options.runId,
        partitionId,
        owner: options.owner,
        fencingToken: options.fencingToken,
        clock: options.clock,
        task: async (worker, prunedAt) => {
          options.guard.throwIfFailed();
          const receipt = pruneReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
          if (receipt.status !== "quarantining") {
            throw new Error("Prune quarantine transition requires a quarantining receipt");
          }
          const quarantinedReceipt = {
            ...receipt,
            status: "quarantined" as const,
            updatedAt: prunedAt,
            producerLease: {
              owner: options.owner,
              fencingToken: options.fencingToken,
              heartbeatAt: worker.heartbeatAt,
            },
          };
          await mkdir(quarantineRoot, { recursive: true });
          for (const directory of PRUNABLE_EVIDENCE_DIRECTORIES) {
            const source = path.join(liveRoot, directory);
            const destination = path.join(quarantineRoot, directory);
            if (await exists(destination)) continue;
            if (!(await exists(source))) continue;
            options.guard.throwIfFailed();
            await rename(source, destination);
            options.guard.throwIfFailed();
          }
          await atomicWriteExternalJson(receiptPath, pruneReceiptSchema.parse(quarantinedReceipt));
        },
      }),
    );
    await options.afterPruneQuarantined?.();
    await options.guard.guardCommit(() =>
      withClermontWorkerFence({
        storeRoot: options.runStore,
        runId: options.runId,
        partitionId,
        owner: options.owner,
        fencingToken: options.fencingToken,
        clock: options.clock,
        task: async (_worker, deletedAt) => {
          options.guard.throwIfFailed();
          const receipt = pruneReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
          if (receipt.status !== "quarantined") {
            throw new Error("Prune deletion requires a quarantined receipt");
          }
          await rm(quarantineRoot, { recursive: true, force: true });
          options.guard.throwIfFailed();
          await atomicWriteExternalJson(
            receiptPath,
            pruneReceiptSchema.parse({ ...receipt, status: "deleted", updatedAt: deletedAt }),
          );
        },
      }),
    );
    await rmdir(path.join(liveRoot, ".pruned")).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    });
  }
  return committedHandoff;
}

async function recoverClermontPruneQuarantine(options: {
  repoRoot: string;
  liveArtifactsRoot?: string;
  runStore: string;
  runId: string;
  year: number;
  partitionId: string;
  owner: string;
  fencingToken: number;
  clock: () => string;
  guard: ClermontLeaseGuard;
  handoff: ClermontPartitionHandoff;
}): Promise<void> {
  const liveRoot = clermontLivePartitionRoot(
    options.repoRoot,
    options.runId,
    options.year,
    options.liveArtifactsRoot,
  );
  const receiptPath = path.join(liveRoot, "loose-evidence-pruned.json");
  if (!(await exists(receiptPath))) return;
  let receipt = pruneReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
  if (
    receipt.runId !== options.runId ||
    receipt.year !== options.year ||
    receipt.handoffSha256 !== sha256Text(canonicalJson(options.handoff)) ||
    receipt.artifactsSha256 !== sha256Text(canonicalJson(options.handoff.artifacts))
  ) {
    throw new Error(`Prune recovery receipt disagrees for ${options.partitionId}`);
  }
  const quarantineRoot = path.resolve(liveRoot, receipt.quarantineRelativePath);
  if (!quarantineRoot.startsWith(`${path.resolve(liveRoot)}${path.sep}.pruned${path.sep}`)) {
    throw new Error("Prune recovery quarantine escapes the live partition root");
  }
  if (receipt.status !== "deleted") {
    await options.guard.guardCommit(() =>
      withClermontWorkerFence({
        storeRoot: options.runStore,
        runId: options.runId,
        partitionId: options.partitionId,
        owner: options.owner,
        fencingToken: options.fencingToken,
        clock: options.clock,
        task: async (_worker, recoveredAt) => {
          options.guard.throwIfFailed();
          await mkdir(quarantineRoot, { recursive: true });
          for (const directory of receipt.plannedDirectories) {
            const source = path.join(liveRoot, directory);
            const destination = path.join(quarantineRoot, directory);
            if (await exists(destination)) continue;
            if (!(await exists(source))) continue;
            options.guard.throwIfFailed();
            await rename(source, destination);
            options.guard.throwIfFailed();
          }
          receipt = pruneReceiptSchema.parse({
            ...receipt,
            status: "quarantined",
            updatedAt: recoveredAt,
            recoveredBy: { owner: options.owner, fencingToken: options.fencingToken },
          });
          await atomicWriteExternalJson(receiptPath, receipt);
        },
      }),
    );
  }
  await options.guard.guardCommit(() =>
    withClermontWorkerFence({
      storeRoot: options.runStore,
      runId: options.runId,
      partitionId: options.partitionId,
      owner: options.owner,
      fencingToken: options.fencingToken,
      clock: options.clock,
      task: async (_worker, deletedAt) => {
        options.guard.throwIfFailed();
        await rm(quarantineRoot, { recursive: true, force: true });
        options.guard.throwIfFailed();
        if (receipt.status !== "deleted") {
          receipt = pruneReceiptSchema.parse({
            ...receipt,
            status: "deleted",
            updatedAt: deletedAt,
            recoveredBy: { owner: options.owner, fencingToken: options.fencingToken },
          });
          await atomicWriteExternalJson(receiptPath, receipt);
        }
      },
    }),
  );
  await rmdir(path.join(liveRoot, ".pruned")).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  });
}

async function linkOrCopy(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    await copyFile(source, destination);
  }
}

async function reuseImmutablePartition(options: {
  runStore: string;
  runId: string;
  baselineStore: string;
  baseline: ClermontCertifiedBaseline;
  year: number;
  owner: string;
  fencingToken: number;
  clock: () => string;
  guard: ClermontLeaseGuard;
}): Promise<ClermontPartitionHandoff> {
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  const prior = options.baseline.partitions.find(({ year }) => year === options.year);
  if (prior === undefined) throw new Error(`Certified baseline lacks year ${options.year}`);
  const digest = prepared.request.baseline.requiredSha256;
  if (digest === null) throw new Error("Immutable reuse requires a baseline digest");
  const sourceRoot = path.join(options.baselineStore, "baselines", digest);
  const candidateRoot = path.join(
    clermontRunDirectory(options.runStore, options.runId),
    "candidate",
  );
  for (const artifact of Object.values(prior.artifacts)) {
    options.guard.throwIfFailed();
    await linkOrCopy(
      path.join(sourceRoot, artifact.logicalPath),
      path.join(candidateRoot, artifact.logicalPath),
    );
    options.guard.throwIfFailed();
  }
  const checkpointSha256 = sha256Text(
    canonicalJson({
      runId: options.runId,
      year: options.year,
      reusedFrom: digest,
      priorCheckpoint: prior.checkpoint.checkpointSha256,
      artifacts: prior.artifacts,
      signatures: prepared.request.signatures,
    }),
  );
  let handoff: ClermontPartitionHandoff | null = null;
  await options.guard.guardCommit(() =>
    writeFencedClermontRunArtifact({
      storeRoot: options.runStore,
      runId: options.runId,
      partitionId: prior.partitionId,
      owner: options.owner,
      fencingToken: options.fencingToken,
      clock: options.clock,
      relativePath: `candidate/partitions/${options.year}/handoff.json`,
      value: (worker, handoffAt) => {
        options.guard.throwIfFailed();
        if (worker.heartbeatAt === null) throw new Error("Fenced worker has no heartbeat evidence");
        handoff = clermontPartitionHandoffSchema.parse({
          ...prior,
          runId: options.runId,
          createdAt: handoffAt,
          producerLease: {
            owner: options.owner,
            fencingToken: options.fencingToken,
            heartbeatAt: worker.heartbeatAt,
          },
          checkpoint: {
            ...prior.checkpoint,
            checkpointSha256,
            signatures: prepared.request.signatures,
          },
          signatures: prepared.request.signatures,
        });
        return handoff;
      },
    }),
  );
  if (handoff === null) throw new Error("Fenced reuse handoff was not committed");
  return handoff;
}

async function acquirePersistentWorker(options: {
  runStore: string;
  runId: string;
  partitionId: string;
  owner: string;
  clock: () => string;
}): Promise<ClermontWorkerState> {
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  const worker = await loadClermontWorker(options.runStore, options.runId, options.partitionId);
  return updateClermontWorker({
    storeRoot: options.runStore,
    runId: options.runId,
    partitionId: options.partitionId,
    expectedFencingToken: worker.fencingToken,
    update: (current) =>
      acquireClermontWorkerLease({
        worker: current,
        request: prepared.request,
        owner: options.owner,
        now: options.clock(),
      }),
  });
}

async function verifyRecoverableTerminalHandoff(options: {
  candidateRoot: string;
  prepared: Awaited<ReturnType<typeof loadClermontPreparedRun>>;
  handoff: ClermontPartitionHandoff;
  runId: string;
  year: number;
  partitionId: string;
}): Promise<void> {
  const { handoff } = options;
  if (
    handoff.runId !== options.runId ||
    handoff.year !== options.year ||
    handoff.partitionId !== options.partitionId ||
    canonicalJson(handoff.signatures) !== canonicalJson(options.prepared.request.signatures) ||
    canonicalJson(handoff.checkpoint.signatures) !==
      canonicalJson(options.prepared.request.signatures)
  ) {
    throw new Error(`Terminal handoff identity or signatures disagree for ${options.partitionId}`);
  }
  if (
    handoff.status !== "captured_complete" ||
    !handoff.checkpoint.terminal ||
    handoff.cappedOrTruncated ||
    handoff.counts.retryablePending !== 0
  ) {
    throw new Error(`Terminal handoff contract is incomplete for ${options.partitionId}`);
  }
  const correlation = await verifyClermontEvidenceCorrelation({
    candidateRoot: options.candidateRoot,
    handoff,
  });
  const statusRecords = correlation.statusRecords;
  const reconciled = reconcileClermontPartitionRecords(statusRecords);
  if (
    canonicalJson(reconciled.counts) !== canonicalJson(handoff.counts) ||
    reconciled.stableIdsSha256 !== handoff.stableIdsSha256 ||
    canonicalJson(reconciled.openPermitStableIds) !== canonicalJson(handoff.openPermitStableIds) ||
    correlation.rawCount !== handoff.counts.rawEvidence ||
    correlation.extractedCount !== handoff.counts.completed
  ) {
    throw new Error(`Terminal handoff artifact reconciliation failed for ${options.partitionId}`);
  }
}

export async function runClermontAcquisition(options: {
  repoRoot: string;
  runStore: string;
  baselineStore: string | null;
  runId: string;
  owner: string;
  now: string;
  liveFetch: boolean;
  pruneLooseAfterSeal?: boolean;
  clock?: () => string;
  harvesterRunner?: (options: ClermontHarvesterRunOptions) => Promise<void>;
  partitionSealer?: typeof sealClermontPartitionEvidence;
  terminationGraceMs?: number;
  liveArtifactsRoot?: string;
}): Promise<{
  completedYears: number[];
  pendingYears: number[];
  exhaustedYears: number[];
}> {
  if (!options.liveFetch) {
    throw new Error("Clermont acquisition requires explicit liveFetch authorization");
  }
  if (!Number.isFinite(Date.parse(options.now))) {
    throw new Error("Clermont audit --now value must be ISO-8601");
  }
  const currentTime = validatedMonotonicClock(
    options.clock ?? createElapsedClermontClock(new Date().toISOString()),
  );
  const harvesterRunner = options.harvesterRunner ?? runClermontHarvesterProcess;
  const partitionSealer = options.partitionSealer ?? sealClermontPartitionEvidence;
  const terminationGraceMs = options.terminationGraceMs ?? 10_000;
  if (
    !Number.isInteger(terminationGraceMs) ||
    terminationGraceMs < 1 ||
    terminationGraceMs > MAX_HARVESTER_TERMINATION_GRACE_MS
  ) {
    throw new Error("Harvester termination grace must be between 1ms and 60000ms");
  }
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  await verifyClermontPreparedScopes({ repoRoot: options.repoRoot, prepared });
  const executionObservedAt = currentTime();
  for (const year of CLERMONT_PERMIT_YEARS) {
    const priorWorker = await loadClermontWorker(
      options.runStore,
      options.runId,
      `lake-clermont-etrakit-${year}`,
    );
    if (
      priorWorker.heartbeatAt !== null &&
      Date.parse(priorWorker.heartbeatAt) > Date.parse(executionObservedAt)
    ) {
      throw new Error("Active execution clock is earlier than a persisted worker heartbeat");
    }
  }
  const executionCostGate = evaluateClermontCostGate({
    request: prepared.request,
    now: executionObservedAt,
  });
  const coordinatorAtExecution = await loadClermontCoordinator(options.runStore, options.runId);
  if (
    executionCostGate.estimate.estimateSha256 !== coordinatorAtExecution.estimate.estimateSha256
  ) {
    throw new Error("Execution-time cost estimate drifted from the prepared coordinator");
  }
  if (prepared.request.authorization === null && prepared.template.authorization !== null) {
    throw new Error("Prepared authorization contract is inconsistent");
  }
  const authorization = prepared.request.authorization;
  const manualAuthorization = executionCostGate.estimate.requiresManualAuthorization;
  if (manualAuthorization && authorization === null) {
    throw new Error("Execution-time cost authorization is missing, expired, or mismatched");
  }
  const maximumCostUsd = manualAuthorization
    ? authorization!.maxCostUsd
    : prepared.request.limits.costCeilingUsd;
  const approvedExecutionHours = manualAuthorization
    ? authorization!.maxExecutionHours
    : prepared.request.limits.maxAutomaticHours;
  const nonRunnerEstimatedCost = Math.max(
    0,
    executionCostGate.estimate.estimatedCostUsd -
      executionCostGate.estimate.estimatedHours * prepared.request.limits.runnerHourlyUsd,
  );
  const costBoundedHours =
    prepared.request.limits.runnerHourlyUsd === 0
      ? approvedExecutionHours
      : (maximumCostUsd - nonRunnerEstimatedCost) / prepared.request.limits.runnerHourlyUsd;
  const maximumExecutionHours = Math.min(approvedExecutionHours, costBoundedHours);
  if (!Number.isFinite(maximumExecutionHours) || maximumExecutionHours <= 0) {
    throw new Error("Approved Clermont budget leaves no positive execution window");
  }
  const runDirectory = clermontRunDirectory(options.runStore, options.runId);
  const budgetPath = path.join(runDirectory, "authorization", "execution-budget.json");
  const budgetIdentity = {
    schemaVersion: "elephant.clermont-execution-budget.v1" as const,
    runId: options.runId,
    requestSha256: prepared.requestSha256,
    provenanceSha256: prepared.provenanceSha256,
    estimateSha256: executionCostGate.estimate.estimateSha256,
    maximumExecutionHours,
    maximumCostUsd,
  };
  let budget: z.infer<typeof executionBudgetSchema>;
  const bootstrapLock = await acquireClermontRunLock(
    manualAuthorization ? path.join(options.runStore, ".authorization-ledger-lock") : runDirectory,
  );
  try {
    let budgetStartedAt = executionObservedAt;
    if (manualAuthorization) {
      const exactAuthorization = authorization!;
      const approvalSha256 = sha256Text(canonicalJson(exactAuthorization));
      const receiptIdentity = {
        schemaVersion: "elephant.clermont-execution-cost-authorization.v2" as const,
        authorizationId: exactAuthorization.authorizationId,
        runId: options.runId,
        requestSha256: prepared.requestSha256,
        provenanceSha256: prepared.provenanceSha256,
        estimateSha256: executionCostGate.estimate.estimateSha256,
        approvalSha256,
      };
      const ledgerDirectory = path.join(options.runStore, "authorization-ledger");
      const ledgerPath = path.join(ledgerDirectory, `${exactAuthorization.authorizationId}.json`);
      await mkdir(ledgerDirectory, { recursive: true });
      let ledgerReceipt: z.infer<typeof executionCostAuthorizationSchema>;
      if (await exists(ledgerPath)) {
        ledgerReceipt = executionCostAuthorizationSchema.parse(
          JSON.parse(await readFile(ledgerPath, "utf8")),
        );
        const { consumedAt: _consumedAt, ...persistedIdentity } = ledgerReceipt;
        if (canonicalJson(persistedIdentity) !== canonicalJson(receiptIdentity)) {
          throw new Error("Cost authorization nonce was already consumed by another run");
        }
      } else {
        if (!executionCostGate.authorized) {
          throw new Error("Execution-time cost authorization is missing, expired, or mismatched");
        }
        ledgerReceipt = executionCostAuthorizationSchema.parse({
          ...receiptIdentity,
          consumedAt: executionObservedAt,
        });
        await writeOnceExternalJson(ledgerPath, ledgerReceipt, bootstrapLock.assertOwned);
      }
      const consumedAtMs = Date.parse(ledgerReceipt.consumedAt);
      if (
        consumedAtMs < Date.parse(exactAuthorization.approvedAt) ||
        consumedAtMs >= Date.parse(exactAuthorization.expiresAt)
      ) {
        throw new Error("Persisted cost authorization consumption is outside its approval window");
      }
      if (Date.parse(executionObservedAt) < consumedAtMs) {
        throw new Error("Active execution clock predates cost authorization consumption");
      }
      const receiptPath = path.join(
        runDirectory,
        "authorization",
        "execution-cost-consumption.json",
      );
      if (await exists(receiptPath)) {
        const runReceipt = executionCostAuthorizationSchema.parse(
          JSON.parse(await readFile(receiptPath, "utf8")),
        );
        if (canonicalJson(runReceipt) !== canonicalJson(ledgerReceipt)) {
          throw new Error("Execution cost authorization receipt does not match the exact run");
        }
      } else {
        await writeOnceExternalJson(receiptPath, ledgerReceipt, bootstrapLock.assertOwned);
      }
      // The store-wide one-use ledger is the first irreversible action. Starting
      // the wall-time budget at its immutable consumption time closes the crash
      // window between ledger, run receipt, and budget creation.
      budgetStartedAt = ledgerReceipt.consumedAt;
    } else if (!executionCostGate.authorized) {
      throw new Error("Execution-time cost gate is not authorized");
    }
    if (await exists(budgetPath)) {
      budget = executionBudgetSchema.parse(JSON.parse(await readFile(budgetPath, "utf8")));
      const { startedAt: _startedAt, deadlineAt: _deadlineAt, ...persistedIdentity } = budget;
      if (canonicalJson(persistedIdentity) !== canonicalJson(budgetIdentity)) {
        throw new Error("Persisted execution budget does not bind the exact prepared run");
      }
      if (manualAuthorization && budget.startedAt !== budgetStartedAt) {
        throw new Error("Persisted execution budget is not anchored to authorization consumption");
      }
    } else {
      const expectedBudget = executionBudgetSchema.parse({
        ...budgetIdentity,
        startedAt: budgetStartedAt,
        deadlineAt: new Date(
          Date.parse(budgetStartedAt) + maximumExecutionHours * 60 * 60 * 1_000,
        ).toISOString(),
      });
      await writeOnceExternalJson(budgetPath, expectedBudget, bootstrapLock.assertOwned);
      budget = expectedBudget;
    }
  } finally {
    await bootstrapLock.release();
  }
  const budgetObservedAt = currentTime();
  if (Date.parse(budgetObservedAt) < Date.parse(budget.startedAt)) {
    throw new Error("Active execution clock predates the durable execution budget");
  }
  const budgetController = new AbortController();
  const budgetFailure = () => new Error("Clermont execution exceeded its approved total budget");
  const assertWithinExecutionBudget = (observedAt = currentTime()): void => {
    if (Date.parse(observedAt) >= Date.parse(budget.deadlineAt)) {
      const error = budgetFailure();
      if (!budgetController.signal.aborted) budgetController.abort(error);
      throw error;
    }
  };
  assertWithinExecutionBudget(budgetObservedAt);
  const budgetTimer = setTimeout(
    () => {
      if (!budgetController.signal.aborted) budgetController.abort(budgetFailure());
    },
    Date.parse(budget.deadlineAt) - Date.parse(budgetObservedAt),
  );
  budgetTimer.unref();
  try {
    if (prepared.request.refreshMode === "incremental" && options.baselineStore === null) {
      throw new Error("Incremental acquisition requires the exact baseline store");
    }
    let baseline: ClermontCertifiedBaseline | null = null;
    if (prepared.request.baseline.requiredSha256 !== null) {
      if (options.baselineStore === null) throw new Error("Baseline store is required");
      baseline = (
        await loadLastGoodClermontBaseline({
          storeRoot: options.baselineStore,
          now: currentTime(),
          maxAgeHours: prepared.request.baseline.maxAgeHours,
          expectedSignatures: prepared.request.signatures,
          expectedSha256: prepared.request.baseline.requiredSha256,
        })
      ).baseline;
    }

    async function startStage(stage: ClermontStageName): Promise<void> {
      const current = await loadClermontCoordinator(options.runStore, options.runId);
      if (
        current.stages[stage].status === "complete" ||
        current.stages[stage].status === "running"
      ) {
        return;
      }
      await updateClermontCoordinator({
        storeRoot: options.runStore,
        runId: options.runId,
        expectedRevision: current.revision,
        update: (state) => startClermontStage(state, stage, currentTime()),
      });
    }
    await startStage("enumeration");

    const scriptPath = path.join(
      options.repoRoot,
      "pipeline",
      "scripts",
      "lake",
      "clermont-permits.mjs",
    );
    const completedYears: number[] = [];
    const pendingYears: number[] = [];
    const exhaustedYears: number[] = [];
    const enumeratedYears = new Set<number>();
    const candidateRoot = path.join(
      clermontRunDirectory(options.runStore, options.runId),
      "candidate",
    );
    for (const partition of buildClermontRefreshPlan({ request: prepared.request, baseline })
      .partitions) {
      assertWithinExecutionBudget();
      const handoffPath = path.join(
        clermontRunDirectory(options.runStore, options.runId),
        "candidate",
        "partitions",
        String(partition.year),
        "handoff.json",
      );
      if (await exists(handoffPath)) {
        const existingHandoff = clermontPartitionHandoffSchema.parse(
          JSON.parse(await readFile(handoffPath, "utf8")),
        );
        if (existingHandoff.status === "captured_complete") {
          await verifyRecoverableTerminalHandoff({
            candidateRoot,
            prepared,
            handoff: existingHandoff,
            runId: options.runId,
            year: partition.year,
            partitionId: partition.partitionId,
          });
          const durableWorker = await loadClermontWorker(
            options.runStore,
            options.runId,
            partition.partitionId,
          );
          if (durableWorker.status === "failed_exhausted") {
            throw new Error(`Terminal handoff ${partition.partitionId} has an exhausted worker`);
          }
          if (durableWorker.status !== "idle") {
            const observedAt = currentTime();
            const leaseLive =
              durableWorker.leaseExpiresAt !== null &&
              Date.parse(durableWorker.leaseExpiresAt) > Date.parse(observedAt);
            const cooldownLive =
              durableWorker.nextAttemptAt !== null &&
              Date.parse(durableWorker.nextAttemptAt) > Date.parse(observedAt);
            if (leaseLive || cooldownLive) {
              enumeratedYears.add(partition.year);
              pendingYears.push(partition.year);
              continue;
            }
            const recoveryWorker = await acquirePersistentWorker({
              runStore: options.runStore,
              runId: options.runId,
              partitionId: partition.partitionId,
              owner: options.owner,
              clock: currentTime,
            });
            const recoveryToken = recoveryWorker.fencingToken;
            const recoverySupervisor = startClermontLeaseSupervisor({
              heartbeatIntervalMs: prepared.request.limits.heartbeatIntervalMs,
              initialCheckpointSha256: existingHandoff.checkpoint.checkpointSha256,
              heartbeat: async (checkpointSha256) => {
                await updateClermontWorker({
                  storeRoot: options.runStore,
                  runId: options.runId,
                  partitionId: partition.partitionId,
                  expectedFencingToken: recoveryToken,
                  update: (current) =>
                    heartbeatClermontWorker({
                      worker: current,
                      request: prepared.request,
                      owner: options.owner,
                      fencingToken: recoveryToken,
                      checkpointSha256,
                      checkpointSignatures: prepared.request.signatures,
                      now: currentTime(),
                    }),
                });
              },
              parentSignal: budgetController.signal,
            });
            try {
              await recoverClermontPruneQuarantine({
                repoRoot: options.repoRoot,
                liveArtifactsRoot: options.liveArtifactsRoot,
                runStore: options.runStore,
                runId: options.runId,
                year: partition.year,
                partitionId: partition.partitionId,
                owner: options.owner,
                fencingToken: recoveryToken,
                clock: currentTime,
                guard: recoverySupervisor,
                handoff: existingHandoff,
              });
              await recoverySupervisor.pulse();
              await recoverySupervisor.finish(() =>
                updateClermontWorker({
                  storeRoot: options.runStore,
                  runId: options.runId,
                  partitionId: partition.partitionId,
                  expectedFencingToken: recoveryToken,
                  update: (current) =>
                    completeClermontWorkerAttempt({
                      worker: current,
                      owner: options.owner,
                      fencingToken: recoveryToken,
                      now: currentTime(),
                    }),
                }),
              );
            } catch (error) {
              await recoverySupervisor.stop().catch(() => undefined);
              throw recoverySupervisor.leaseError ?? error;
            }
          } else if (
            durableWorker.checkpointSha256 !== existingHandoff.checkpoint.checkpointSha256
          ) {
            throw new Error(`Terminal worker checkpoint disagrees for ${partition.partitionId}`);
          }
          enumeratedYears.add(partition.year);
          completedYears.push(partition.year);
          continue;
        }
      }
      const currentWorker = await loadClermontWorker(
        options.runStore,
        options.runId,
        partition.partitionId,
      );
      if (currentWorker.status === "failed_exhausted") {
        exhaustedYears.push(partition.year);
        continue;
      }
      if (
        currentWorker.status === "cooling_down" &&
        currentWorker.nextAttemptAt !== null &&
        Date.parse(currentWorker.nextAttemptAt) > Date.parse(currentTime())
      ) {
        pendingYears.push(partition.year);
        continue;
      }
      const worker = await acquirePersistentWorker({
        runStore: options.runStore,
        runId: options.runId,
        partitionId: partition.partitionId,
        owner: options.owner,
        clock: currentTime,
      });
      const token = worker.fencingToken;
      const liveRoot = clermontLivePartitionRoot(
        options.repoRoot,
        options.runId,
        partition.year,
        options.liveArtifactsRoot,
      );
      const logPath = path.join(
        clermontRunDirectory(options.runStore, options.runId),
        "logs",
        `${partition.partitionId}.log`,
      );
      const supervisor = startClermontLeaseSupervisor({
        heartbeatIntervalMs: prepared.request.limits.heartbeatIntervalMs,
        initialCheckpointSha256:
          worker.checkpointSha256 ?? sha256Text(`${options.runId}:${partition.year}:started`),
        heartbeat: async (checkpointSha256) => {
          await updateClermontWorker({
            storeRoot: options.runStore,
            runId: options.runId,
            partitionId: partition.partitionId,
            expectedFencingToken: token,
            update: (current) =>
              heartbeatClermontWorker({
                worker: current,
                request: prepared.request,
                owner: options.owner,
                fencingToken: token,
                checkpointSha256,
                checkpointSignatures: prepared.request.signatures,
                now: currentTime(),
              }),
          });
        },
        parentSignal: budgetController.signal,
      });
      try {
        if (partition.action === "reuse-immutable") {
          if (baseline === null || options.baselineStore === null) {
            throw new Error("Reuse partition has no certified baseline");
          }
          const handoff = await reuseImmutablePartition({
            runStore: options.runStore,
            runId: options.runId,
            baselineStore: options.baselineStore,
            baseline,
            year: partition.year,
            owner: options.owner,
            fencingToken: token,
            clock: currentTime,
            guard: supervisor,
          });
          supervisor.setCheckpoint(handoff.checkpoint.checkpointSha256);
          await supervisor.pulse();
          enumeratedYears.add(partition.year);
        } else {
          const indexPath = path.join(liveRoot, "permit-lists", "clermont-permit-index.json");
          if (!(await exists(indexPath))) {
            await harvesterRunner({
              scriptPath,
              args: [
                "enumerate",
                "--years",
                String(partition.year).slice(-2),
                "--job-id",
                livePartitionJobId(options.runId, partition.year),
                "--concurrency",
                String(prepared.executor.concurrency),
                "--max-attempts",
                String(prepared.request.limits.requestAttemptsPerOperation),
              ],
              logPath,
              timeoutMs: prepared.executor.partitionTimeoutMs,
              terminationGraceMs,
              signal: supervisor.signal,
            });
            assertWithinExecutionBudget();
            await supervisor.assertActive();
          }
          enumeratedYears.add(partition.year);
          const boundedIndex = permitIndexSchema.parse(
            JSON.parse(await readFile(indexPath, "utf8")),
          );
          if (boundedIndex.permitCount > partition.expectedRecords) {
            throw new Error(
              `Year ${partition.year} enumeration exceeded its approved record budget`,
            );
          }
          const approvedPrefixSearches = clermontEnumerationPrefixBound({
            expectedRecords: partition.expectedRecords,
            resultCap: prepared.request.limits.enumerationResultCap,
            absoluteMaximum: prepared.request.limits.maxEnumerationPrefixesPerYear,
          });
          if (boundedIndex.prefixesSearched > approvedPrefixSearches) {
            throw new Error(
              `Year ${partition.year} enumeration exceeded its approved prefix-search budget`,
            );
          }
          supervisor.setCheckpoint(sha256Text(`${options.runId}:${partition.year}:enumerated`));
          await supervisor.pulse();
          await harvesterRunner({
            scriptPath,
            args: [
              "harvest",
              "--job-id",
              livePartitionJobId(options.runId, partition.year),
              "--concurrency",
              String(prepared.executor.concurrency),
              "--delay-ms",
              String(prepared.executor.delayMs),
              "--max-attempts",
              String(prepared.request.limits.requestAttemptsPerOperation),
            ],
            logPath,
            timeoutMs: prepared.executor.partitionTimeoutMs,
            terminationGraceMs,
            signal: supervisor.signal,
          });
          assertWithinExecutionBudget();
          await supervisor.assertActive();
          const handoff = await partitionSealer({
            repoRoot: options.repoRoot,
            runStore: options.runStore,
            runId: options.runId,
            year: partition.year,
            owner: options.owner,
            fencingToken: token,
            clock: currentTime,
            guard: supervisor,
            liveArtifactsRoot: options.liveArtifactsRoot,
            pruneLooseAfterSeal: options.pruneLooseAfterSeal,
          });
          assertWithinExecutionBudget();
          supervisor.setCheckpoint(handoff.checkpoint.checkpointSha256);
          await supervisor.pulse();
          await supervisor.assertActive();
          if (handoff.status !== "captured_complete") {
            const nextWorker = await supervisor.finish(() =>
              updateClermontWorker({
                storeRoot: options.runStore,
                runId: options.runId,
                partitionId: partition.partitionId,
                expectedFencingToken: token,
                update: (current) =>
                  failClermontWorkerAttempt({
                    worker: current,
                    request: prepared.request,
                    owner: options.owner,
                    fencingToken: token,
                    now: currentTime(),
                  }),
              }),
            );
            if (nextWorker.status === "failed_exhausted") exhaustedYears.push(partition.year);
            else pendingYears.push(partition.year);
            continue;
          }
        }
        await supervisor.finish(() =>
          updateClermontWorker({
            storeRoot: options.runStore,
            runId: options.runId,
            partitionId: partition.partitionId,
            expectedFencingToken: token,
            update: (current) =>
              completeClermontWorkerAttempt({
                worker: current,
                owner: options.owner,
                fencingToken: token,
                now: currentTime(),
              }),
          }),
        );
        completedYears.push(partition.year);
      } catch (error) {
        const originalError = supervisor.leaseError ?? asError(error);
        try {
          await supervisor.stop();
        } catch {
          // The first lease error remains the authoritative failure.
        }
        let nextWorker: ClermontWorkerState;
        try {
          nextWorker = await updateClermontWorker({
            storeRoot: options.runStore,
            runId: options.runId,
            partitionId: partition.partitionId,
            expectedFencingToken: token,
            update: (current) =>
              failClermontWorkerAttempt({
                worker: current,
                request: prepared.request,
                owner: options.owner,
                fencingToken: token,
                now: currentTime(),
              }),
          });
        } catch {
          throw originalError;
        }
        if (nextWorker.status === "failed_exhausted") exhaustedYears.push(partition.year);
        else pendingYears.push(partition.year);
        await writeClermontRunArtifact({
          storeRoot: options.runStore,
          runId: options.runId,
          relativePath: `failures/${partition.partitionId}-attempt-${nextWorker.attempts}.json`,
          value: {
            partitionId: partition.partitionId,
            attempt: nextWorker.attempts,
            observedAt: nextWorker.heartbeatAt,
            category: "retryable",
            message: originalError.message,
          },
        });
        if (supervisor.leaseError !== null) throw originalError;
      }
    }
    assertWithinExecutionBudget();
    const progressDigest = sha256Text(
      canonicalJson({
        completedYears: [...completedYears].sort(),
        pendingYears: [...pendingYears].sort(),
        exhaustedYears: [...exhaustedYears].sort(),
        enumeratedYears: [...enumeratedYears].sort(),
      }),
    );
    let coordinator = await loadClermontCoordinator(options.runStore, options.runId);
    if (coordinator.stages.enumeration.status === "running") {
      coordinator = await updateClermontCoordinator({
        storeRoot: options.runStore,
        runId: options.runId,
        expectedRevision: coordinator.revision,
        update: (state) =>
          enumeratedYears.size === 12
            ? completeClermontStage(state, "enumeration", progressDigest, currentTime())
            : deferClermontStage(
                state,
                "enumeration",
                exhaustedYears.length > 0 ? "failed_exhausted" : "cooling_down",
                progressDigest,
                currentTime(),
              ),
      });
    }
    if (enumeratedYears.size === 12) {
      await startStage("acquisition");
      coordinator = await loadClermontCoordinator(options.runStore, options.runId);
      if (coordinator.stages.acquisition.status === "running") {
        coordinator = await updateClermontCoordinator({
          storeRoot: options.runStore,
          runId: options.runId,
          expectedRevision: coordinator.revision,
          update: (state) =>
            completedYears.length === 12
              ? completeClermontStage(state, "acquisition", progressDigest, currentTime())
              : deferClermontStage(
                  state,
                  "acquisition",
                  exhaustedYears.length > 0 ? "failed_exhausted" : "cooling_down",
                  progressDigest,
                  currentTime(),
                ),
        });
      }
      if (completedYears.length === 12) {
        await startStage("reconciliation");
        coordinator = await loadClermontCoordinator(options.runStore, options.runId);
        if (coordinator.stages.reconciliation.status === "running") {
          await updateClermontCoordinator({
            storeRoot: options.runStore,
            runId: options.runId,
            expectedRevision: coordinator.revision,
            update: (state) =>
              completeClermontStage(state, "reconciliation", progressDigest, currentTime()),
          });
        }
      }
    }
    if (exhaustedYears.length > 0) {
      throw new Error(
        `Clermont acquisition exhausted its retry budget for years: ${[...exhaustedYears]
          .sort()
          .join(", ")}`,
      );
    }
    return { completedYears, pendingYears, exhaustedYears };
  } finally {
    clearTimeout(budgetTimer);
  }
}
