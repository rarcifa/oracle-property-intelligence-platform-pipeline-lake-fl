import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { z } from "zod";

import { canonicalJson } from "./contracts.js";
import { clermontSignatureSetSchema } from "./clermont-contracts.js";
import {
  CLERMONT_COORDINATOR_SCHEMA_VERSION,
  type ClermontCoordinatorState,
  type ClermontWorkerState,
} from "./clermont-coordinator.js";
import { clermontPreparedRunSchema, type ClermontPreparedRun } from "./clermont-run-contracts.js";

const RUN_LOCK_STALE_MS = 5 * 60 * 1_000;
const RUN_REAPER_STALE_MS = 5 * 60 * 1_000;
const RUN_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const RUN_LOCK_RETRY_MS = 10;
const RUN_LOCK_REFRESH_MS = 60_000;
const LOCAL_HOSTNAME = hostname();
const runIdSchema = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const stageStateSchema = z
  .object({
    status: z.enum([
      "pending",
      "ready",
      "running",
      "cooling_down",
      "waiting_human",
      "complete",
      "failed_exhausted",
    ]),
    attempt: z.number().int().nonnegative(),
    evidenceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const coordinatorSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_COORDINATOR_SCHEMA_VERSION),
    revision: z.number().int().positive(),
    runId: runIdSchema,
    state: z.enum(["READY", "RUNNING", "WAITING_HUMAN", "FAILED_EXHAUSTED", "COMPLETE"]),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    provenanceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    estimate: z.object({}).passthrough(),
    refreshPlan: z.object({}).passthrough(),
    stages: z.record(z.string(), stageStateSchema),
    nextAutomaticTransition: z.string().nullable(),
  })
  .passthrough();

const workerSchema = z
  .object({
    partitionId: z.string().regex(/^lake-clermont-etrakit-20(1[5-9]|2[0-6])$/),
    status: z.enum(["idle", "running", "cooling_down", "failed_exhausted"]),
    leaseOwner: z.string().min(1).max(200).nullable(),
    leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
    heartbeatAt: z.string().datetime({ offset: true }).nullable(),
    fencingToken: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    circuit: z.enum(["closed", "open", "half_open"]),
    nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
    checkpointSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    signatures: clermontSignatureSetSchema,
  })
  .strict();

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function confinedRunDirectory(storeRoot: string, runIdValue: string): string {
  const runId = runIdSchema.parse(runIdValue);
  return path.join(path.resolve(storeRoot), "runs", runId);
}

async function atomicWrite(
  filePath: string,
  value: unknown,
  assertOwned?: () => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx" });
    await assertOwned?.();
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeOnceOrRequireEqual(
  filePath: string,
  value: unknown,
  assertOwned?: () => Promise<void>,
): Promise<void> {
  const encoded = `${canonicalJson(value)}\n`;
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx" });
    await assertOwned?.();
    await link(temporary, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(filePath, "utf8")) !== encoded) {
      throw new Error(`Immutable run artifact already exists with different bytes: ${filePath}`);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function retryLock(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RUN_LOCK_RETRY_MS));
}

interface ClermontLockOwner {
  token: string;
  pid: number | null;
  hostname: string | null;
}

async function readLockOwner(lockPath: string): Promise<ClermontLockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      token?: unknown;
      pid?: unknown;
      hostname?: unknown;
    };
    return typeof value.token === "string"
      ? {
          token: value.token,
          pid: typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : null,
          hostname: typeof value.hostname === "string" ? value.hostname : null,
        }
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameLockOwner(left: ClermontLockOwner | null, right: ClermontLockOwner | null): boolean {
  return left?.token === right?.token;
}

function localOwnerIsAlive(owner: ClermontLockOwner | null): boolean {
  if (owner?.hostname !== LOCAL_HOSTNAME || owner.pid === null || owner.pid < 1) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireReaper(
  reaperPath: string,
  deadline: number,
): Promise<{ release: () => Promise<void> }> {
  const token = randomUUID();
  while (Date.now() <= deadline) {
    try {
      await mkdir(reaperPath);
      await writeFile(
        path.join(reaperPath, "owner.json"),
        `${canonicalJson({ token, pid: process.pid, hostname: LOCAL_HOSTNAME, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          if ((await readLockOwner(reaperPath))?.token === token) {
            await rm(reaperPath, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const reaperStat = await stat(reaperPath).catch(() => null);
      const reaperOwner = await readLockOwner(reaperPath);
      if (
        reaperStat !== null &&
        Date.now() - reaperStat.mtimeMs > RUN_REAPER_STALE_MS &&
        !localOwnerIsAlive(reaperOwner)
      ) {
        const observedOwner = await readLockOwner(reaperPath);
        const quarantinePath = `${reaperPath}.stale-${randomUUID()}`;
        try {
          await rename(reaperPath, quarantinePath);
          const movedOwner = await readLockOwner(quarantinePath);
          if (sameLockOwner(movedOwner, observedOwner)) {
            await rm(quarantinePath, { recursive: true, force: true });
          } else {
            await rename(quarantinePath, reaperPath).catch(() => undefined);
          }
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
        }
      }
      await retryLock();
    }
  }
  throw new Error("Timed out waiting for Clermont lock ownership guard");
}

async function releaseOwnedLock(options: {
  lockPath: string;
  reaperPath: string;
  token: string;
  deadline: number;
}): Promise<void> {
  const reaper = await acquireReaper(options.reaperPath, options.deadline);
  try {
    if ((await readLockOwner(options.lockPath))?.token === options.token) {
      await rm(options.lockPath, { recursive: true, force: true });
    }
  } finally {
    await reaper.release();
  }
}

async function refreshOwnedLock(options: {
  lockPath: string;
  reaperPath: string;
  token: string;
  deadline: number;
}): Promise<void> {
  const reaper = await acquireReaper(options.reaperPath, options.deadline);
  try {
    if ((await readLockOwner(options.lockPath))?.token !== options.token) {
      throw new Error("Clermont coordinator lock ownership was lost");
    }
    const refreshedAt = new Date();
    await utimes(options.lockPath, refreshedAt, refreshedAt);
  } finally {
    await reaper.release();
  }
}

async function reapStaleLock(options: {
  lockPath: string;
  reaperPath: string;
  deadline: number;
  staleMs: number;
}): Promise<void> {
  const reaper = await acquireReaper(options.reaperPath, options.deadline);
  try {
    const lockStat = await stat(options.lockPath).catch(() => null);
    const owner = await readLockOwner(options.lockPath);
    if (
      lockStat !== null &&
      Date.now() - lockStat.mtimeMs > options.staleMs &&
      !localOwnerIsAlive(owner)
    ) {
      await rm(options.lockPath, { recursive: true, force: true });
    }
  } finally {
    await reaper.release();
  }
}

export async function acquireClermontRunLock(
  runDirectoryValue: string,
  timing: { acquireTimeoutMs?: number; staleMs?: number } = {},
): Promise<{
  token: string;
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
}> {
  const runDirectory = path.resolve(runDirectoryValue);
  await mkdir(runDirectory, { recursive: true });
  const lockPath = path.join(runDirectory, "coordinator.lock");
  const reaperPath = path.join(runDirectory, "coordinator.lock.reaper");
  const token = randomUUID();
  const acquireTimeoutMs = timing.acquireTimeoutMs ?? RUN_LOCK_ACQUIRE_TIMEOUT_MS;
  const staleMs = timing.staleMs ?? RUN_LOCK_STALE_MS;
  if (!Number.isInteger(acquireTimeoutMs) || acquireTimeoutMs < 1 || acquireTimeoutMs > 60_000) {
    throw new Error("Clermont run-lock acquire timeout must be between 1ms and 60000ms");
  }
  if (!Number.isInteger(staleMs) || staleMs < 1 || staleMs > 60 * 60 * 1_000) {
    throw new Error("Clermont run-lock stale threshold must be between 1ms and 3600000ms");
  }
  const deadline = Date.now() + acquireTimeoutMs;
  let acquired = false;
  while (!acquired && Date.now() <= deadline) {
    if (await exists(reaperPath)) {
      const reaper = await acquireReaper(reaperPath, deadline);
      await reaper.release();
      continue;
    }
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${canonicalJson({ token, pid: process.pid, hostname: LOCAL_HOSTNAME, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      if (await exists(reaperPath)) {
        await releaseOwnedLock({ lockPath, reaperPath, token, deadline });
        await retryLock();
      } else {
        acquired = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reapStaleLock({ lockPath, reaperPath, deadline, staleMs });
      await retryLock();
    }
  }
  if (!acquired) throw new Error("Timed out waiting for Clermont coordinator lock");
  let released = false;
  let refreshFlight: Promise<void> | null = null;
  let ownershipError: Error | null = null;
  const assertOwned = async (): Promise<void> => {
    if (ownershipError !== null) throw ownershipError;
    if (released) throw new Error("Clermont coordinator lock is already released");
    if (refreshFlight !== null) return refreshFlight;
    const flight = refreshOwnedLock({
      lockPath,
      reaperPath,
      token,
      deadline: Date.now() + RUN_LOCK_ACQUIRE_TIMEOUT_MS,
    })
      .catch((error: unknown) => {
        ownershipError = error instanceof Error ? error : new Error(String(error));
        throw ownershipError;
      })
      .finally(() => {
        if (refreshFlight === flight) refreshFlight = null;
      });
    refreshFlight = flight;
    return flight;
  };
  const refreshTimer = setInterval(() => {
    void assertOwned().catch(() => undefined);
  }, RUN_LOCK_REFRESH_MS);
  refreshTimer.unref();
  return {
    token,
    assertOwned,
    async release() {
      if (released) return;
      released = true;
      clearInterval(refreshTimer);
      if (refreshFlight !== null) await refreshFlight.catch(() => undefined);
      await releaseOwnedLock({
        lockPath,
        reaperPath,
        token,
        deadline: Date.now() + RUN_LOCK_ACQUIRE_TIMEOUT_MS,
      });
    },
  };
}

async function withRunLock<T>(
  runDirectory: string,
  task: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lock = await acquireClermontRunLock(runDirectory);
  try {
    const result = await task(lock.assertOwned);
    await lock.assertOwned();
    return result;
  } finally {
    await lock.release();
  }
}

function requireLiveWorkerFence(options: {
  worker: ClermontWorkerState;
  owner: string;
  fencingToken: number;
  now: string;
}): void {
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new Error("Worker fence time must be ISO-8601");
  if (
    options.worker.status !== "running" ||
    options.worker.leaseOwner !== options.owner ||
    options.worker.fencingToken !== options.fencingToken
  ) {
    throw new Error("Worker lease owner or fencing token is stale");
  }
  if (
    options.worker.leaseExpiresAt === null ||
    Date.parse(options.worker.leaseExpiresAt) <= nowMs
  ) {
    throw new Error("Worker lease has expired");
  }
}

function requirePreparedWorkerSignatures(
  worker: ClermontWorkerState,
  prepared: ClermontPreparedRun,
): void {
  if (canonicalJson(worker.signatures) !== canonicalJson(prepared.request.signatures)) {
    throw new Error("Worker signatures drifted from the exact prepared run");
  }
}

function requirePreparedCoordinatorBinding(
  coordinator: ClermontCoordinatorState,
  prepared: ClermontPreparedRun,
): void {
  if (
    coordinator.runId !== prepared.request.runId ||
    coordinator.requestSha256 !== prepared.requestSha256 ||
    coordinator.provenanceSha256 !== prepared.provenanceSha256
  ) {
    throw new Error("Coordinator identity or provenance drifted from the exact prepared run");
  }
}

function requireLegalWorkerTransition(
  current: ClermontWorkerState,
  next: ClermontWorkerState,
): void {
  if (next.partitionId !== current.partitionId) {
    throw new Error("Worker update cannot change its partition identity");
  }
  if (canonicalJson(next.signatures) !== canonicalJson(current.signatures)) {
    throw new Error("Worker update cannot change its prepared signatures");
  }
  if (next.fencingToken < current.fencingToken || next.fencingToken > current.fencingToken + 1) {
    throw new Error("Worker fencing token must stay fixed or advance exactly once");
  }
  const acquiring = next.fencingToken === current.fencingToken + 1;
  if (acquiring) {
    if (
      current.status === "failed_exhausted" ||
      next.status !== "running" ||
      next.leaseOwner === null ||
      next.leaseExpiresAt === null ||
      next.heartbeatAt === null ||
      next.attempts !== current.attempts + 1
    ) {
      throw new Error("A fencing-token advance must be one legal lease acquisition");
    }
    const acquiredAtMs = Date.parse(next.heartbeatAt);
    if (
      (current.heartbeatAt !== null && Date.parse(current.heartbeatAt) > acquiredAtMs) ||
      (current.leaseExpiresAt !== null && Date.parse(current.leaseExpiresAt) > acquiredAtMs) ||
      (current.nextAttemptAt !== null && Date.parse(current.nextAttemptAt) > acquiredAtMs)
    ) {
      throw new Error("A lease acquisition cannot predate its heartbeat, expiry, or cooldown");
    }
  } else {
    if (next.attempts !== current.attempts) {
      throw new Error("Worker attempts can advance only with a new fencing token");
    }
    const allowed: Record<ClermontWorkerState["status"], ClermontWorkerState["status"][]> = {
      idle: ["idle"],
      running: ["running", "cooling_down", "failed_exhausted", "idle"],
      cooling_down: ["cooling_down"],
      failed_exhausted: ["failed_exhausted"],
    };
    if (!allowed[current.status].includes(next.status)) {
      throw new Error(`Illegal worker status transition ${current.status} -> ${next.status}`);
    }
    if (current.status === "running" && next.status === "running") {
      const stableCurrent = {
        ...current,
        heartbeatAt: null,
        leaseExpiresAt: null,
        checkpointSha256: null,
      };
      const stableNext = {
        ...next,
        heartbeatAt: null,
        leaseExpiresAt: null,
        checkpointSha256: null,
      };
      if (canonicalJson(stableCurrent) !== canonicalJson(stableNext)) {
        throw new Error("A same-token worker renewal may only advance heartbeat and checkpoint");
      }
      if (
        current.leaseExpiresAt !== null &&
        next.leaseExpiresAt !== null &&
        Date.parse(next.leaseExpiresAt) < Date.parse(current.leaseExpiresAt)
      ) {
        throw new Error("A same-token worker renewal cannot shorten its lease");
      }
    }
  }
  if (
    current.heartbeatAt !== null &&
    next.heartbeatAt !== null &&
    Date.parse(next.heartbeatAt) < Date.parse(current.heartbeatAt)
  ) {
    throw new Error("Worker heartbeat timestamp cannot move backwards");
  }
  if (next.status === "running") {
    if (next.leaseOwner === null || next.leaseExpiresAt === null || next.heartbeatAt === null) {
      throw new Error("A running worker requires an owner, heartbeat, and lease expiry");
    }
    if (Date.parse(next.leaseExpiresAt) <= Date.parse(next.heartbeatAt)) {
      throw new Error("Worker lease expiry must follow its heartbeat");
    }
    if (next.nextAttemptAt !== null) {
      throw new Error("A running worker cannot retain a cooldown timestamp");
    }
  } else if (next.leaseOwner !== null || next.leaseExpiresAt !== null) {
    throw new Error("A non-running worker cannot retain a lease owner or expiry");
  }
  if (next.status === "cooling_down") {
    if (
      next.heartbeatAt === null ||
      next.nextAttemptAt === null ||
      Date.parse(next.nextAttemptAt) <= Date.parse(next.heartbeatAt)
    ) {
      throw new Error("A cooling worker requires a future cooldown timestamp");
    }
  } else if (next.nextAttemptAt !== null) {
    throw new Error("Only a cooling worker may retain a cooldown timestamp");
  }
}

function requireCoordinatorTimestampsMonotonic(
  current: ClermontCoordinatorState,
  next: ClermontCoordinatorState,
): void {
  const currentLatest = Math.max(
    ...Object.values(current.stages).map(({ updatedAt }) => Date.parse(updatedAt)),
  );
  for (const [stage, nextStage] of Object.entries(next.stages)) {
    const prior = current.stages[stage as keyof typeof current.stages];
    if (prior !== undefined && Date.parse(nextStage.updatedAt) < Date.parse(prior.updatedAt)) {
      throw new Error(`Coordinator timestamp moved backwards for stage ${stage}`);
    }
    if (
      prior !== undefined &&
      canonicalJson(nextStage) !== canonicalJson(prior) &&
      Date.parse(nextStage.updatedAt) < currentLatest
    ) {
      throw new Error(`Coordinator transition timestamp predates durable state for stage ${stage}`);
    }
  }
}

export async function initializeClermontRun(options: {
  storeRoot: string;
  prepared: ClermontPreparedRun;
  coordinator: ClermontCoordinatorState;
  workers: ClermontWorkerState[];
}): Promise<string> {
  const prepared = clermontPreparedRunSchema.parse(options.prepared);
  const coordinator = coordinatorSchema.parse(
    options.coordinator,
  ) as unknown as ClermontCoordinatorState;
  if (prepared.request.runId !== coordinator.runId) {
    throw new Error("Prepared request and coordinator run IDs disagree");
  }
  requirePreparedCoordinatorBinding(coordinator, prepared);
  const runDirectory = confinedRunDirectory(options.storeRoot, coordinator.runId);
  await mkdir(path.join(runDirectory, "workers"), { recursive: true });
  await writeOnceOrRequireEqual(path.join(runDirectory, "prepared.json"), prepared);
  await writeOnceOrRequireEqual(path.join(runDirectory, "request.json"), prepared.request);
  await writeOnceOrRequireEqual(path.join(runDirectory, "coordinator.json"), coordinator);
  for (const workerValue of options.workers) {
    const worker = workerSchema.parse(workerValue) as ClermontWorkerState;
    requirePreparedWorkerSignatures(worker, prepared);
    await writeOnceOrRequireEqual(
      path.join(runDirectory, "workers", `${worker.partitionId}.json`),
      worker,
    );
  }
  return runDirectory;
}

export async function loadClermontPreparedRun(
  storeRoot: string,
  runId: string,
): Promise<ClermontPreparedRun> {
  const runDirectory = confinedRunDirectory(storeRoot, runId);
  return clermontPreparedRunSchema.parse(
    JSON.parse(await readFile(path.join(runDirectory, "prepared.json"), "utf8")),
  );
}

export async function loadClermontCoordinator(
  storeRoot: string,
  runId: string,
): Promise<ClermontCoordinatorState> {
  const runDirectory = confinedRunDirectory(storeRoot, runId);
  const coordinator = coordinatorSchema.parse(
    JSON.parse(await readFile(path.join(runDirectory, "coordinator.json"), "utf8")),
  ) as unknown as ClermontCoordinatorState;
  const prepared = await loadClermontPreparedRun(storeRoot, runId);
  requirePreparedCoordinatorBinding(coordinator, prepared);
  return coordinator;
}

export async function updateClermontCoordinator(options: {
  storeRoot: string;
  runId: string;
  expectedRevision: number;
  update: (current: ClermontCoordinatorState) => ClermontCoordinatorState;
}): Promise<ClermontCoordinatorState> {
  const runDirectory = confinedRunDirectory(options.storeRoot, options.runId);
  return withRunLock(runDirectory, async (assertOwned) => {
    const current = await loadClermontCoordinator(options.storeRoot, options.runId);
    if (current.revision !== options.expectedRevision) {
      throw new Error(
        `Coordinator revision fence failed: expected ${options.expectedRevision}, found ${current.revision}`,
      );
    }
    const next = coordinatorSchema.parse(
      options.update(current),
    ) as unknown as ClermontCoordinatorState;
    if (next.runId !== current.runId || next.revision <= current.revision) {
      throw new Error("Coordinator update must preserve run identity and advance its revision");
    }
    const prepared = await loadClermontPreparedRun(options.storeRoot, options.runId);
    requirePreparedCoordinatorBinding(next, prepared);
    requireCoordinatorTimestampsMonotonic(current, next);
    await atomicWrite(path.join(runDirectory, "coordinator.json"), next, assertOwned);
    return next;
  });
}

export async function loadClermontWorker(
  storeRoot: string,
  runId: string,
  partitionId: string,
): Promise<ClermontWorkerState> {
  const runDirectory = confinedRunDirectory(storeRoot, runId);
  return workerSchema.parse(
    JSON.parse(
      await readFile(
        path.join(runDirectory, "workers", `${path.basename(partitionId)}.json`),
        "utf8",
      ),
    ),
  ) as ClermontWorkerState;
}

export async function updateClermontWorker(options: {
  storeRoot: string;
  runId: string;
  partitionId: string;
  expectedFencingToken: number;
  update: (current: ClermontWorkerState) => ClermontWorkerState;
}): Promise<ClermontWorkerState> {
  const runDirectory = confinedRunDirectory(options.storeRoot, options.runId);
  return withRunLock(runDirectory, async (assertOwned) => {
    const prepared = await loadClermontPreparedRun(options.storeRoot, options.runId);
    const current = await loadClermontWorker(options.storeRoot, options.runId, options.partitionId);
    requirePreparedWorkerSignatures(current, prepared);
    if (current.fencingToken !== options.expectedFencingToken) {
      throw new Error(
        `Worker fencing token failed: expected ${options.expectedFencingToken}, found ${current.fencingToken}`,
      );
    }
    const next = workerSchema.parse(options.update(current)) as ClermontWorkerState;
    requirePreparedWorkerSignatures(next, prepared);
    requireLegalWorkerTransition(current, next);
    await atomicWrite(
      path.join(runDirectory, "workers", `${current.partitionId}.json`),
      next,
      assertOwned,
    );
    return next;
  });
}

export async function withClermontWorkerFence<T>(options: {
  storeRoot: string;
  runId: string;
  partitionId: string;
  owner: string;
  fencingToken: number;
  clock: () => string;
  task: (
    worker: ClermontWorkerState,
    fencedAt: string,
    assertRunLockOwned: () => Promise<void>,
  ) => Promise<T>;
}): Promise<T> {
  const runDirectory = confinedRunDirectory(options.storeRoot, options.runId);
  return withRunLock(runDirectory, async (assertOwned) => {
    const prepared = await loadClermontPreparedRun(options.storeRoot, options.runId);
    const worker = await loadClermontWorker(options.storeRoot, options.runId, options.partitionId);
    requirePreparedWorkerSignatures(worker, prepared);
    const fencedAt = options.clock();
    requireLiveWorkerFence({
      worker,
      owner: options.owner,
      fencingToken: options.fencingToken,
      now: fencedAt,
    });
    await assertOwned();
    return options.task(worker, fencedAt, assertOwned);
  });
}

export async function writeFencedClermontRunArtifact(options: {
  storeRoot: string;
  runId: string;
  partitionId: string;
  owner: string;
  fencingToken: number;
  clock: () => string;
  relativePath: string;
  value: (worker: ClermontWorkerState, fencedAt: string) => unknown;
  immutable?: boolean;
}): Promise<string> {
  const runDirectory = confinedRunDirectory(options.storeRoot, options.runId);
  const resolved = path.resolve(runDirectory, options.relativePath);
  if (!resolved.startsWith(`${runDirectory}${path.sep}`)) {
    throw new Error("Run artifact path escapes the run directory");
  }
  return withRunLock(runDirectory, async (assertOwned) => {
    const prepared = await loadClermontPreparedRun(options.storeRoot, options.runId);
    const worker = await loadClermontWorker(options.storeRoot, options.runId, options.partitionId);
    requirePreparedWorkerSignatures(worker, prepared);
    const fencedAt = options.clock();
    requireLiveWorkerFence({
      worker,
      owner: options.owner,
      fencingToken: options.fencingToken,
      now: fencedAt,
    });
    const value = options.value(worker, fencedAt);
    await assertOwned();
    await mkdir(path.dirname(resolved), { recursive: true });
    if (options.immutable ?? true) await writeOnceOrRequireEqual(resolved, value, assertOwned);
    else await atomicWrite(resolved, value, assertOwned);
    return resolved;
  });
}

export async function writeClermontRunArtifact(options: {
  storeRoot: string;
  runId: string;
  relativePath: string;
  value: unknown;
  immutable?: boolean;
}): Promise<string> {
  const runDirectory = confinedRunDirectory(options.storeRoot, options.runId);
  const resolved = path.resolve(runDirectory, options.relativePath);
  if (!resolved.startsWith(`${runDirectory}${path.sep}`)) {
    throw new Error("Run artifact path escapes the run directory");
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  if (options.immutable ?? true) await writeOnceOrRequireEqual(resolved, options.value);
  else await atomicWrite(resolved, options.value);
  return resolved;
}

export function clermontRunDirectory(storeRoot: string, runId: string): string {
  return confinedRunDirectory(storeRoot, runId);
}

export async function clermontRunExists(storeRoot: string, runId: string): Promise<boolean> {
  return exists(path.join(confinedRunDirectory(storeRoot, runId), "prepared.json"));
}
