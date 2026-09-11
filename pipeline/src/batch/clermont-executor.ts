import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";

import { z } from "zod";

import { canonicalJson, sha256Text } from "./contracts.js";
import {
  CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION,
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
  completeClermontStage,
  deferClermontStage,
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
  clermontRunDirectory,
  loadClermontCoordinator,
  loadClermontPreparedRun,
  loadClermontWorker,
  updateClermontWorker,
  updateClermontCoordinator,
  writeClermontRunArtifact,
} from "./clermont-run-store.js";

const OPEN_STATUSES = new Set([
  "ISSUED",
  "APPROVED",
  "APPROVED PENDING",
  "IN REVIEW",
  "PENDING INFORMATION",
]);

const permitIndexSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-permit-index.v1"),
    jobId: z.string().min(1),
    jurisdictionKey: z.literal("clermont"),
    sourceUrl: z.literal("https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx"),
    years: z.array(z.string().regex(/^\d{2}$/)).length(1),
    unresolvedPrefixes: z.array(z.string()),
    permitCount: z.number().int().nonnegative(),
    permits: z.array(
      z
        .object({
          permitNumber: z.string().min(1),
          alternateKey: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
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
}): Promise<ClermontImmutableArtifact> {
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const temporary = `${options.outputPath}.${randomUUID()}.tmp`;
  async function* encodedValues(): AsyncGenerator<string> {
    for await (const value of options.values) yield `${canonicalJson(value)}\n`;
  }
  const source = Readable.from(encodedValues(), { encoding: "utf8" });
  // Node writes a zero gzip mtime, so identical NDJSON produces identical bytes.
  await pipeline(source, createGzip({ level: 9 }), createWriteStream(temporary, { flags: "wx" }));
  await rename(temporary, options.outputPath);
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

async function runHarvester(options: {
  scriptPath: string;
  args: string[];
  logPath: string;
  timeoutMs: number;
  heartbeatIntervalMs: number;
  onHeartbeat: () => Promise<void>;
}): Promise<void> {
  await mkdir(path.dirname(options.logPath), { recursive: true });
  const output = createWriteStream(options.logPath, { flags: "a" });
  const child = spawn(process.execPath, [options.scriptPath, ...options.args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let heartbeatError: Error | null = null;
  const heartbeat = setInterval(() => {
    void options.onHeartbeat().catch((error: unknown) => {
      heartbeatError = error instanceof Error ? error : new Error(String(error));
      child.kill("SIGTERM");
    });
  }, options.heartbeatIntervalMs);
  heartbeat.unref();
  const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
  timeout.unref();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    output.end();
  });
  if (heartbeatError !== null) throw heartbeatError;
  if (exit.code !== 0) {
    throw new Error(
      `Clermont harvester failed (code ${String(exit.code)}, signal ${String(exit.signal)}); inspect ${options.logPath}`,
    );
  }
}

function livePartitionJobId(runId: string, year: number): string {
  return `${runId}-y${year}`;
}

function livePartitionRoot(repoRoot: string, runId: string, year: number): string {
  return path.join(
    repoRoot,
    "pipeline",
    "data",
    "artifacts",
    "permits",
    "lake",
    livePartitionJobId(runId, year),
  );
}

function stableId(permitNumber: string): string {
  return `lake:clermont:etrakit:${permitNumber}`;
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
  now: string;
  failedExhausted?: boolean;
  pruneLooseAfterSeal?: boolean;
}): Promise<ClermontPartitionHandoff> {
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  const liveRoot = livePartitionRoot(options.repoRoot, options.runId, options.year);
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

  const rawEntries: Array<{ stableId: string; mediaType: string; filePath: string }> = [];
  const extractedEntries: Array<{ stableId: string; filePath: string }> = [];
  const evidence: ClermontRecordEvidence[] = [];
  for (const row of [...index.permits].sort((left, right) =>
    left.permitNumber.localeCompare(right.permitNumber),
  )) {
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
      const record = JSON.parse(extractedText) as Record<string, unknown>;
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
  const partitionRoot = path.join(candidateRoot, "partitions", String(options.year));
  async function* rawLines(): AsyncGenerator<unknown> {
    for (const entry of rawEntries) {
      const body = await readFile(entry.filePath, "utf8");
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
      const body = await readFile(entry.filePath, "utf8");
      yield { stableId: entry.stableId, sha256: sha256Text(body), body };
    }
  }
  const artifacts = {
    raw: await writeDeterministicGzipNdjson({
      candidateRoot,
      outputPath: path.join(partitionRoot, "raw.ndjson.gz"),
      values: rawLines(),
      expectedCount: rawEntries.length,
    }),
    extracted: await writeDeterministicGzipNdjson({
      candidateRoot,
      outputPath: path.join(partitionRoot, "extracted.ndjson.gz"),
      values: extractedLines(),
      expectedCount: extractedEntries.length,
    }),
    status: await writeDeterministicGzipNdjson({
      candidateRoot,
      outputPath: path.join(partitionRoot, "status.ndjson.gz"),
      values: evidence,
      expectedCount: evidence.length,
    }),
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
  const handoff = clermontPartitionHandoffSchema.parse({
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
    partitionId: `lake-clermont-etrakit-${options.year}`,
    createdAt: options.now,
    sourceWindowState: options.year >= 2025 ? "active" : "closed",
    status: terminal
      ? "captured_complete"
      : options.failedExhausted
        ? "failed_exhausted"
        : "cooling_down",
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
    signatures: prepared.request.signatures,
  });
  await writeClermontRunArtifact({
    storeRoot: options.runStore,
    runId: options.runId,
    relativePath: `candidate/partitions/${options.year}/handoff.json`,
    value: handoff,
    immutable: terminal,
  });
  if (terminal && options.pruneLooseAfterSeal) {
    // The three archives were digest-checked and fully decoded above. Only
    // redundant loose evidence is removed; the index, logs, summaries and
    // immutable archives remain sufficient for replay and certification.
    for (const directory of ["raw", "extracted", "status", "dead"]) {
      await rm(path.join(liveRoot, directory), { recursive: true, force: true });
    }
    await writeFile(
      path.join(liveRoot, "loose-evidence-pruned.json"),
      `${canonicalJson({ runId: options.runId, year: options.year, prunedAt: options.now, artifacts })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }
  return handoff;
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
  now: string;
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
    await linkOrCopy(
      path.join(sourceRoot, artifact.logicalPath),
      path.join(candidateRoot, artifact.logicalPath),
    );
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
  const handoff = clermontPartitionHandoffSchema.parse({
    ...prior,
    runId: options.runId,
    createdAt: options.now,
    checkpoint: {
      ...prior.checkpoint,
      checkpointSha256,
      signatures: prepared.request.signatures,
    },
    signatures: prepared.request.signatures,
  });
  await writeClermontRunArtifact({
    storeRoot: options.runStore,
    runId: options.runId,
    relativePath: `candidate/partitions/${options.year}/handoff.json`,
    value: handoff,
  });
  return handoff;
}

async function writeOpenRecordIndex(options: {
  repoRoot: string;
  runId: string;
  year: number;
  stableIds: string[];
  now: string;
}): Promise<void> {
  const liveRoot = livePartitionRoot(options.repoRoot, options.runId, options.year);
  const indexPath = path.join(liveRoot, "permit-lists", "clermont-permit-index.json");
  if (await exists(indexPath)) return;
  const prefix = "lake:clermont:etrakit:";
  const permits = options.stableIds.map((id) => {
    if (!id.startsWith(prefix)) throw new Error(`Invalid open-record stable ID ${id}`);
    const permitNumber = id.slice(prefix.length);
    return { permitNumber, alternateKey: null };
  });
  const index = permitIndexSchema.parse({
    schemaVersion: "elephant.clermont-permit-index.v1",
    jobId: livePartitionJobId(options.runId, options.year),
    jurisdictionKey: "clermont",
    sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
    years: [String(options.year).slice(-2)],
    enumeratedAt: options.now,
    wallSeconds: 0,
    prefixesSearched: 0,
    unresolvedPrefixes: [],
    permitCount: permits.length,
    distinctAlternateKeys: 0,
    permits,
  });
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${canonicalJson(index)}\n`, { encoding: "utf8", flag: "wx" });
}

async function acquirePersistentWorker(options: {
  runStore: string;
  runId: string;
  partitionId: string;
  owner: string;
  now: string;
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
        now: options.now,
      }),
  });
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
}): Promise<{
  completedYears: number[];
  pendingYears: number[];
  exhaustedYears: number[];
}> {
  if (!options.liveFetch) {
    throw new Error("Clermont acquisition requires explicit liveFetch authorization");
  }
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  await verifyClermontPreparedScopes({ repoRoot: options.repoRoot, prepared });
  if (prepared.request.authorization === null && prepared.template.authorization !== null) {
    throw new Error("Prepared authorization contract is inconsistent");
  }
  if (prepared.request.refreshMode === "incremental" && options.baselineStore === null) {
    throw new Error("Incremental acquisition requires the exact baseline store");
  }
  let baseline: ClermontCertifiedBaseline | null = null;
  if (prepared.request.baseline.requiredSha256 !== null) {
    if (options.baselineStore === null) throw new Error("Baseline store is required");
    baseline = (
      await loadLastGoodClermontBaseline({
        storeRoot: options.baselineStore,
        now: options.now,
        maxAgeHours: prepared.request.baseline.maxAgeHours,
        expectedSignatures: prepared.request.signatures,
        expectedSha256: prepared.request.baseline.requiredSha256,
      })
    ).baseline;
  }

  async function startStage(stage: ClermontStageName): Promise<void> {
    const current = await loadClermontCoordinator(options.runStore, options.runId);
    if (current.stages[stage].status === "complete" || current.stages[stage].status === "running") {
      return;
    }
    await updateClermontCoordinator({
      storeRoot: options.runStore,
      runId: options.runId,
      expectedRevision: current.revision,
      update: (state) => startClermontStage(state, stage, options.now),
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
  for (const partition of buildClermontRefreshPlan({ request: prepared.request, baseline })
    .partitions) {
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
        enumeratedYears.add(partition.year);
        completedYears.push(partition.year);
        continue;
      }
    }
    if (partition.action === "reuse-immutable") {
      if (baseline === null || options.baselineStore === null) {
        throw new Error("Reuse partition has no certified baseline");
      }
      await reuseImmutablePartition({
        runStore: options.runStore,
        runId: options.runId,
        baselineStore: options.baselineStore,
        baseline,
        year: partition.year,
        now: options.now,
      });
      completedYears.push(partition.year);
      enumeratedYears.add(partition.year);
      continue;
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
      Date.parse(currentWorker.nextAttemptAt) > Date.parse(options.now)
    ) {
      pendingYears.push(partition.year);
      continue;
    }
    let worker = await acquirePersistentWorker({
      runStore: options.runStore,
      runId: options.runId,
      partitionId: partition.partitionId,
      owner: options.owner,
      now: options.now,
    });
    const token = worker.fencingToken;
    const liveRoot = livePartitionRoot(options.repoRoot, options.runId, partition.year);
    const logPath = path.join(
      clermontRunDirectory(options.runStore, options.runId),
      "logs",
      `${partition.partitionId}.log`,
    );
    const heartbeat = async () => {
      worker = await updateClermontWorker({
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
            checkpointSha256:
              current.checkpointSha256 ?? sha256Text(`${options.runId}:${partition.year}:started`),
            checkpointSignatures: prepared.request.signatures,
            now: new Date().toISOString(),
          }),
      });
    };
    try {
      const indexPath = path.join(liveRoot, "permit-lists", "clermont-permit-index.json");
      if (partition.action === "open-records") {
        await writeOpenRecordIndex({
          repoRoot: options.repoRoot,
          runId: options.runId,
          year: partition.year,
          stableIds: partition.stableIds,
          now: options.now,
        });
      } else if (!(await exists(indexPath))) {
        await runHarvester({
          scriptPath,
          args: [
            "enumerate",
            "--years",
            String(partition.year).slice(-2),
            "--job-id",
            livePartitionJobId(options.runId, partition.year),
            "--concurrency",
            String(prepared.executor.concurrency),
          ],
          logPath,
          timeoutMs: prepared.executor.partitionTimeoutMs,
          heartbeatIntervalMs: prepared.request.limits.heartbeatIntervalMs,
          onHeartbeat: heartbeat,
        });
      }
      enumeratedYears.add(partition.year);
      await runHarvester({
        scriptPath,
        args: [
          "harvest",
          "--job-id",
          livePartitionJobId(options.runId, partition.year),
          "--concurrency",
          String(prepared.executor.concurrency),
          "--delay-ms",
          String(prepared.executor.delayMs),
        ],
        logPath,
        timeoutMs: prepared.executor.partitionTimeoutMs,
        heartbeatIntervalMs: prepared.request.limits.heartbeatIntervalMs,
        onHeartbeat: heartbeat,
      });
      const handoff = await sealClermontPartitionEvidence({
        repoRoot: options.repoRoot,
        runStore: options.runStore,
        runId: options.runId,
        year: partition.year,
        now: options.now,
        pruneLooseAfterSeal: options.pruneLooseAfterSeal,
      });
      if (handoff.status === "captured_complete") {
        await updateClermontWorker({
          storeRoot: options.runStore,
          runId: options.runId,
          partitionId: partition.partitionId,
          expectedFencingToken: token,
          update: (current) =>
            completeClermontWorkerAttempt({
              worker: current,
              owner: options.owner,
              fencingToken: token,
              now: options.now,
            }),
        });
        completedYears.push(partition.year);
      } else {
        const nextWorker = await updateClermontWorker({
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
              now: options.now,
            }),
        });
        if (nextWorker.status === "failed_exhausted") exhaustedYears.push(partition.year);
        else pendingYears.push(partition.year);
      }
    } catch (error) {
      const nextWorker = await updateClermontWorker({
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
            now: options.now,
          }),
      });
      if (nextWorker.status === "failed_exhausted") exhaustedYears.push(partition.year);
      else pendingYears.push(partition.year);
      await writeClermontRunArtifact({
        storeRoot: options.runStore,
        runId: options.runId,
        relativePath: `failures/${partition.partitionId}-attempt-${nextWorker.attempts}.json`,
        value: {
          partitionId: partition.partitionId,
          attempt: nextWorker.attempts,
          observedAt: options.now,
          category: "retryable",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
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
          ? completeClermontStage(state, "enumeration", progressDigest, options.now)
          : deferClermontStage(
              state,
              "enumeration",
              exhaustedYears.length > 0 ? "failed_exhausted" : "cooling_down",
              progressDigest,
              options.now,
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
            ? completeClermontStage(state, "acquisition", progressDigest, options.now)
            : deferClermontStage(
                state,
                "acquisition",
                exhaustedYears.length > 0 ? "failed_exhausted" : "cooling_down",
                progressDigest,
                options.now,
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
            completeClermontStage(state, "reconciliation", progressDigest, options.now),
        });
      }
    }
  }
  return { completedYears, pendingYears, exhaustedYears };
}
