import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

async function writeOnceOrRequireEqual(filePath: string, value: unknown): Promise<void> {
  const encoded = `${canonicalJson(value)}\n`;
  try {
    await writeFile(filePath, encoded, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(filePath, "utf8")) !== encoded) {
      throw new Error(`Immutable run artifact already exists with different bytes: ${filePath}`);
    }
  }
}

async function withRunLock<T>(runDirectory: string, task: () => Promise<T>): Promise<T> {
  await mkdir(runDirectory, { recursive: true });
  const lockPath = path.join(runDirectory, "coordinator.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lockStat = await stat(lockPath).catch(() => null);
    if (lockStat !== null && Date.now() - lockStat.mtimeMs > RUN_LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
      handle = await open(lockPath, "wx");
    } else {
      throw new Error("Clermont coordinator is locked by another live writer");
    }
  }
  try {
    await handle.writeFile(`${process.pid}:${new Date().toISOString()}\n`);
    return await task();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
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
  const runDirectory = confinedRunDirectory(options.storeRoot, coordinator.runId);
  await mkdir(path.join(runDirectory, "workers"), { recursive: true });
  await writeOnceOrRequireEqual(path.join(runDirectory, "prepared.json"), prepared);
  await writeOnceOrRequireEqual(path.join(runDirectory, "request.json"), prepared.request);
  await writeOnceOrRequireEqual(path.join(runDirectory, "coordinator.json"), coordinator);
  for (const workerValue of options.workers) {
    const worker = workerSchema.parse(workerValue) as ClermontWorkerState;
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
  return coordinatorSchema.parse(
    JSON.parse(await readFile(path.join(runDirectory, "coordinator.json"), "utf8")),
  ) as unknown as ClermontCoordinatorState;
}

export async function updateClermontCoordinator(options: {
  storeRoot: string;
  runId: string;
  expectedRevision: number;
  update: (current: ClermontCoordinatorState) => ClermontCoordinatorState;
}): Promise<ClermontCoordinatorState> {
  const runDirectory = confinedRunDirectory(options.storeRoot, options.runId);
  return withRunLock(runDirectory, async () => {
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
    await atomicWrite(path.join(runDirectory, "coordinator.json"), next);
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
  return withRunLock(runDirectory, async () => {
    const current = await loadClermontWorker(options.storeRoot, options.runId, options.partitionId);
    if (current.fencingToken !== options.expectedFencingToken) {
      throw new Error(
        `Worker fencing token failed: expected ${options.expectedFencingToken}, found ${current.fencingToken}`,
      );
    }
    const next = workerSchema.parse(options.update(current)) as ClermontWorkerState;
    if (next.partitionId !== current.partitionId || next.fencingToken < current.fencingToken) {
      throw new Error("Worker update cannot change its identity or decrease its fencing token");
    }
    await atomicWrite(path.join(runDirectory, "workers", `${current.partitionId}.json`), next);
    return next;
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
