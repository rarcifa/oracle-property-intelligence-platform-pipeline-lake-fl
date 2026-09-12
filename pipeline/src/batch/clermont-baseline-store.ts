import { createReadStream, constants } from "node:fs";
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
import { createHash, randomUUID } from "node:crypto";

import { canonicalJson } from "./contracts.js";
import {
  CLERMONT_BASELINE_POINTER_SCHEMA_VERSION,
  clermontBaselineDigest,
  clermontBaselinePointerSchema,
  clermontCertifiedBaselineSchema,
  clermontMergedExportMetadataSchema,
  type ClermontBaselinePointer,
  type ClermontCertifiedBaseline,
  type ClermontSignatureSet,
} from "./clermont-contracts.js";
import {
  ClermontBaselinePreconditionError,
  assertPartitionCanComplete,
} from "./clermont-coordinator.js";
import { acquireClermontRunLock } from "./clermont-run-store.js";

const LAST_GOOD_FILE = "last-good.json";

function assertSignatures(
  baseline: ClermontCertifiedBaseline,
  expected: ClermontSignatureSet,
): void {
  if (canonicalJson(baseline.signatures) !== canonicalJson(expected)) {
    throw new ClermontBaselinePreconditionError(
      "Last-good baseline signatures do not match the requested source, configuration, and schema",
    );
  }
}

function assertFreshBaseline(options: {
  baseline: ClermontCertifiedBaseline;
  now: string;
  maxAgeHours: number;
}): void {
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new Error("now must be an ISO-8601 timestamp");
  const certifiedAtMs = Date.parse(options.baseline.certifiedAt);
  if (certifiedAtMs > nowMs) {
    throw new ClermontBaselinePreconditionError(
      "Last-good baseline certification time is in the future",
    );
  }
  if (Date.parse(options.baseline.expiresAt) <= nowMs) {
    throw new ClermontBaselinePreconditionError("Last-good baseline has expired");
  }
  if (nowMs - certifiedAtMs > options.maxAgeHours * 60 * 60 * 1_000) {
    throw new ClermontBaselinePreconditionError(
      "Last-good baseline is older than the configured freshness boundary",
    );
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function baselinePath(storeRoot: string, digest: string): string {
  return path.join(storeRoot, "baselines", digest, "baseline.json");
}

function artifactReferences(baseline: ClermontCertifiedBaseline) {
  return [
    ...baseline.partitions.flatMap(({ artifacts }) => [
      artifacts.raw,
      artifacts.extracted,
      artifacts.status,
      artifacts.licenseDirectory,
    ]),
    baseline.mergedExport.artifact,
    baseline.mergedExport.metadata,
  ];
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

function confinedArtifactPath(root: string, logicalPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, logicalPath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ClermontBaselinePreconditionError(
      "Baseline artifact path escapes its immutable root",
    );
  }
  return resolved;
}

async function verifyArtifact(
  root: string,
  artifact: { logicalPath: string; sha256: string; bytes: number },
): Promise<void> {
  const filePath = confinedArtifactPath(root, artifact.logicalPath);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new ClermontBaselinePreconditionError(
      `Certified baseline artifact is missing: ${artifact.logicalPath}`,
    );
  }
  if (!fileStat.isFile() || fileStat.size !== artifact.bytes) {
    throw new ClermontBaselinePreconditionError(
      `Certified baseline artifact size mismatch: ${artifact.logicalPath}`,
    );
  }
  if ((await sha256File(filePath)) !== artifact.sha256) {
    throw new ClermontBaselinePreconditionError(
      `Certified baseline artifact digest mismatch: ${artifact.logicalPath}`,
    );
  }
}

async function linkOrCopyFile(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

async function verifyBaselineArtifacts(
  root: string,
  baseline: ClermontCertifiedBaseline,
): Promise<void> {
  const seen = new Map<string, string>();
  for (const artifact of artifactReferences(baseline)) {
    const existingDigest = seen.get(artifact.logicalPath);
    if (existingDigest !== undefined && existingDigest !== artifact.sha256) {
      throw new ClermontBaselinePreconditionError(
        `Baseline artifact path has conflicting digests: ${artifact.logicalPath}`,
      );
    }
    seen.set(artifact.logicalPath, artifact.sha256);
    await verifyArtifact(root, artifact);
  }

  const metadataPath = confinedArtifactPath(root, baseline.mergedExport.metadata.logicalPath);
  let metadata;
  try {
    metadata = clermontMergedExportMetadataSchema.parse(
      JSON.parse(await readFile(metadataPath, "utf8")),
    );
  } catch (error) {
    throw new ClermontBaselinePreconditionError(
      `Certified merged-export metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const enumeratedPermits = baseline.partitions.reduce(
    (sum, partition) => sum + partition.counts.enumerated,
    0,
  );
  const deadPermits = baseline.partitions.reduce(
    (sum, partition) => sum + partition.counts.provenDead,
    0,
  );
  const loadedPermits = baseline.partitions.reduce(
    (sum, partition) => sum + partition.counts.completed,
    0,
  );
  if (
    metadata.jobId !== baseline.partitions[0]?.runId ||
    Date.parse(metadata.exportedAt) > Date.parse(baseline.certifiedAt) ||
    metadata.enumeratedPermits !== enumeratedPermits ||
    metadata.deadPermits !== deadPermits ||
    metadata.achievablePermits !== enumeratedPermits - deadPermits ||
    metadata.loadedPermits !== loadedPermits ||
    baseline.mergedExport.rows !== metadata.loadedPermits
  ) {
    throw new ClermontBaselinePreconditionError(
      "Certified merged-export metadata does not reconcile to the partition evidence",
    );
  }
}

async function readPointerOrNull(storeRoot: string): Promise<ClermontBaselinePointer | null> {
  const pointerPath = path.join(storeRoot, LAST_GOOD_FILE);
  if (!(await exists(pointerPath))) return null;
  return clermontBaselinePointerSchema.parse(JSON.parse(await readFile(pointerPath, "utf8")));
}

async function readBaselineAtPointer(
  storeRoot: string,
  pointer: ClermontBaselinePointer,
): Promise<ClermontCertifiedBaseline> {
  const absoluteBaselinePath = path.resolve(storeRoot, pointer.baselineRelativePath);
  const allowedRoot = `${path.resolve(storeRoot)}${path.sep}`;
  if (!absoluteBaselinePath.startsWith(allowedRoot)) {
    throw new ClermontBaselinePreconditionError(
      "Last-good baseline pointer escapes its store root",
    );
  }
  let encoded: string;
  try {
    encoded = await readFile(absoluteBaselinePath, "utf8");
  } catch {
    throw new ClermontBaselinePreconditionError(
      "Last-good baseline pointer references a missing immutable artifact",
    );
  }
  const baseline = clermontCertifiedBaselineSchema.parse(JSON.parse(encoded));
  if (clermontBaselineDigest(baseline) !== pointer.baselineSha256) {
    throw new ClermontBaselinePreconditionError(
      "Last-good baseline bytes do not match the pointer digest",
    );
  }
  await verifyBaselineArtifacts(path.dirname(absoluteBaselinePath), baseline);
  return baseline;
}

export async function loadLastGoodClermontBaseline(options: {
  storeRoot: string;
  now: string;
  maxAgeHours: number;
  expectedSignatures: ClermontSignatureSet;
  expectedSha256?: string;
}): Promise<{
  pointer: ClermontBaselinePointer;
  baseline: ClermontCertifiedBaseline;
}> {
  const pointer = await readPointerOrNull(options.storeRoot);
  if (pointer === null) {
    throw new ClermontBaselinePreconditionError("No certified Clermont last-good baseline exists");
  }
  if (options.expectedSha256 !== undefined && pointer.baselineSha256 !== options.expectedSha256) {
    throw new ClermontBaselinePreconditionError(
      "Last-good baseline pointer does not match the required immutable digest",
    );
  }
  const baseline = await readBaselineAtPointer(options.storeRoot, pointer);
  assertSignatures(baseline, options.expectedSignatures);
  assertFreshBaseline({
    baseline,
    now: options.now,
    maxAgeHours: options.maxAgeHours,
  });
  return { pointer, baseline };
}

export async function promoteCertifiedClermontBaseline(options: {
  storeRoot: string;
  candidateArtifactRoot: string;
  candidate: ClermontCertifiedBaseline;
  now: string;
  expectedSignatures: ClermontSignatureSet;
  expectedPriorSha256: string | null;
}): Promise<ClermontBaselinePointer> {
  const candidate = clermontCertifiedBaselineSchema.parse(options.candidate);
  assertSignatures(candidate, options.expectedSignatures);
  assertFreshBaseline({ baseline: candidate, now: options.now, maxAgeHours: 24 * 31 });
  for (const partition of candidate.partitions) {
    assertPartitionCanComplete({
      counts: partition.counts,
      cappedOrTruncated: partition.cappedOrTruncated,
    });
  }
  await verifyBaselineArtifacts(options.candidateArtifactRoot, candidate);

  await mkdir(options.storeRoot, { recursive: true });
  const digest = clermontBaselineDigest(candidate);
  const promotionLock = await acquireClermontRunLock(
    path.join(options.storeRoot, ".baseline-promotion-lock"),
  );
  try {
    const existingPointer = await readPointerOrNull(options.storeRoot);
    const existingDigest = existingPointer?.baselineSha256 ?? null;
    if (existingDigest === digest && existingPointer !== null) {
      const existing = await readBaselineAtPointer(options.storeRoot, existingPointer);
      assertSignatures(existing, options.expectedSignatures);
      assertFreshBaseline({ baseline: existing, now: options.now, maxAgeHours: 24 * 31 });
      if (canonicalJson(existing) !== canonicalJson(candidate)) {
        throw new ClermontBaselinePreconditionError(
          "Applied baseline pointer conflicts with the exact recovery candidate",
        );
      }
      return existingPointer;
    }
    if (existingDigest !== options.expectedPriorSha256) {
      throw new ClermontBaselinePreconditionError(
        "Last-good baseline changed since acquisition started; refusing an unfenced promotion",
      );
    }
    if (existingPointer !== null) {
      const existing = await readBaselineAtPointer(options.storeRoot, existingPointer);
      assertSignatures(existing, options.expectedSignatures);
      if (Date.parse(candidate.certifiedAt) <= Date.parse(existing.certifiedAt)) {
        throw new ClermontBaselinePreconditionError(
          "Candidate baseline is not newer than the preserved last-good baseline",
        );
      }
    }

    const immutablePath = baselinePath(options.storeRoot, digest);
    const immutableRoot = path.dirname(immutablePath);
    const encoded = canonicalJson(candidate);
    if (!(await exists(immutableRoot))) {
      const stagingRoot = path.join(
        options.storeRoot,
        "baselines",
        `.candidate.${digest}.${randomUUID()}`,
      );
      await mkdir(stagingRoot, { recursive: true });
      try {
        for (const artifact of artifactReferences(candidate)) {
          const source = confinedArtifactPath(options.candidateArtifactRoot, artifact.logicalPath);
          const destination = confinedArtifactPath(stagingRoot, artifact.logicalPath);
          await mkdir(path.dirname(destination), { recursive: true });
          await linkOrCopyFile(source, destination);
        }
        await writeFile(path.join(stagingRoot, "baseline.json"), encoded, {
          encoding: "utf8",
          flag: "wx",
        });
        try {
          await rename(stagingRoot, immutableRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally {
        if (await exists(stagingRoot)) {
          await rm(stagingRoot, { recursive: true, force: true });
        }
      }
    }
    if ((await readFile(immutablePath, "utf8")) !== encoded) {
      throw new ClermontBaselinePreconditionError(
        "Content-addressed baseline path already contains different bytes",
      );
    }
    await verifyBaselineArtifacts(immutableRoot, candidate);

    const pointer = clermontBaselinePointerSchema.parse({
      schemaVersion: CLERMONT_BASELINE_POINTER_SCHEMA_VERSION,
      baselineSha256: digest,
      baselineRelativePath: `baselines/${digest}/baseline.json`,
      promotedAt: options.now,
    });
    const temporaryPointer = path.join(options.storeRoot, `.last-good.${randomUUID()}.tmp`);
    await writeFile(temporaryPointer, canonicalJson(pointer), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPointer, path.join(options.storeRoot, LAST_GOOD_FILE));
    return pointer;
  } finally {
    await promotionLock.release();
  }
}

/**
 * Publication preparation must call this gate rather than searching for an
 * unnamed "latest" CSV. It intentionally has no network or publishing side
 * effects and fails before a publication candidate can be returned.
 */
export async function requireClermontBaselineForPublication(options: {
  storeRoot: string;
  now: string;
  maxAgeHours: number;
  expectedSignatures: ClermontSignatureSet;
  expectedSha256: string;
}): Promise<ClermontCertifiedBaseline> {
  return (
    await loadLastGoodClermontBaseline({
      ...options,
      expectedSha256: options.expectedSha256,
    })
  ).baseline;
}

export async function materializeLastGoodClermontExport(options: {
  storeRoot: string;
  outputPath: string;
  now: string;
  maxAgeHours: number;
  expectedSignatures: ClermontSignatureSet;
  expectedSha256: string;
}): Promise<{
  baselineSha256: string;
  exportSha256: string;
  metadataSha256: string;
  rows: number;
  outputPath: string;
  metadataPath: string;
}> {
  const { pointer, baseline } = await loadLastGoodClermontBaseline({
    storeRoot: options.storeRoot,
    now: options.now,
    maxAgeHours: options.maxAgeHours,
    expectedSignatures: options.expectedSignatures,
    expectedSha256: options.expectedSha256,
  });
  const immutableRoot = path.dirname(baselinePath(options.storeRoot, pointer.baselineSha256));
  const sourcePath = confinedArtifactPath(
    immutableRoot,
    baseline.mergedExport.artifact.logicalPath,
  );
  const outputPath = path.resolve(options.outputPath);
  if (path.extname(outputPath).toLowerCase() !== ".csv") {
    throw new ClermontBaselinePreconditionError(
      "Clermont merged export output must use a .csv extension",
    );
  }
  const metadataSourcePath = confinedArtifactPath(
    immutableRoot,
    baseline.mergedExport.metadata.logicalPath,
  );
  const metadataPath = outputPath.replace(/\.csv$/i, ".meta.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryOutput = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomUUID()}.tmp`,
  );
  const temporaryMetadata = path.join(
    path.dirname(metadataPath),
    `.${path.basename(metadataPath)}.${randomUUID()}.tmp`,
  );
  const outputBackup = `${temporaryOutput}.previous`;
  const metadataBackup = `${temporaryMetadata}.previous`;
  let outputBackedUp = false;
  let metadataBackedUp = false;
  let outputActivated = false;
  let metadataActivated = false;
  let pairActivated = false;
  try {
    await copyFile(sourcePath, temporaryOutput, constants.COPYFILE_EXCL);
    await verifyArtifact(path.dirname(temporaryOutput), {
      ...baseline.mergedExport.artifact,
      logicalPath: path.basename(temporaryOutput),
    });
    await copyFile(metadataSourcePath, temporaryMetadata, constants.COPYFILE_EXCL);
    await verifyArtifact(path.dirname(temporaryMetadata), {
      ...baseline.mergedExport.metadata,
      logicalPath: path.basename(temporaryMetadata),
    });

    if (await exists(outputPath)) {
      await rename(outputPath, outputBackup);
      outputBackedUp = true;
    }
    if (await exists(metadataPath)) {
      await rename(metadataPath, metadataBackup);
      metadataBackedUp = true;
    }
    await rename(temporaryMetadata, metadataPath);
    metadataActivated = true;
    await rename(temporaryOutput, outputPath);
    outputActivated = true;
    pairActivated = true;
  } catch (error) {
    if (outputActivated) await rm(outputPath, { force: true });
    if (metadataActivated) await rm(metadataPath, { force: true });
    if (outputBackedUp) {
      await rename(outputBackup, outputPath);
      outputBackedUp = false;
    }
    if (metadataBackedUp) {
      await rename(metadataBackup, metadataPath);
      metadataBackedUp = false;
    }
    throw error;
  } finally {
    if (await exists(temporaryOutput)) {
      await rm(temporaryOutput, { force: true });
    }
    if (await exists(temporaryMetadata)) {
      await rm(temporaryMetadata, { force: true });
    }
    if (pairActivated && (await exists(outputBackup))) {
      await rm(outputBackup, { force: true });
    }
    if (pairActivated && (await exists(metadataBackup))) {
      await rm(metadataBackup, { force: true });
    }
  }
  return {
    baselineSha256: pointer.baselineSha256,
    exportSha256: baseline.mergedExport.artifact.sha256,
    metadataSha256: baseline.mergedExport.metadata.sha256,
    rows: baseline.mergedExport.rows,
    outputPath,
    metadataPath,
  };
}
