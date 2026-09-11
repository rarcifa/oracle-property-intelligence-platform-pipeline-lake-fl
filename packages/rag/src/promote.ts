/**
 * Promote one finalized public run into the deterministic RAG corpus.
 *
 * This is deliberately not "edit corpus-source.json". The command proves the
 * public pointer, artifact manifest, two-gateway verification receipt and
 * transactional FINALIZED ledger all identify the same immutable run before
 * it writes a receipt or rebuilds the index.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";

import { writeIndex, INDEX_PATH } from "./index/build-index.js";
import {
  CORPUS_SOURCE_PATH,
  REPO_ROOT,
  corpusSourceSchema,
  promotionReceiptSchema,
} from "./corpus/source.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cid = z.string().regex(/^b[a-z2-7]{20,}$/);
const runId = z.string().regex(/^\d{8}T\d{6}Z$/);
const requiredArtifacts = Object.freeze([
  "coverage.json",
  "index.json",
  "permit-schema.json",
  "schema.json",
  "samples/aged-roofs.json",
  "samples/open-roofing-permits.json",
  "samples/out-of-area-owners.json",
]);

const latestSchema = z
  .object({
    runId,
    mode: z.enum(["full", "incremental"]),
    candidateWorkflowRunId: z.string(),
    rootCid: cid,
    manifestCid: cid,
    resolvedCid: cid,
    publishedAt: z.string().datetime({ offset: true }),
  })
  .passthrough();

const manifestSchema = z
  .object({
    schemaVersion: z.literal("elephant.artifact-manifest.v1"),
    runId,
    county: z.literal("lake"),
    root: z.object({ cid }).passthrough(),
    artifacts: z.array(
      z
        .object({
          name: z.string(),
          sha256: digest,
          codec: z.enum(["file", "directory"]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const verificationSchema = z
  .object({
    runId,
    mode: z.enum(["full", "incremental"]),
    candidateWorkflowRunId: z.string(),
    rootCid: cid,
    manifestCid: cid,
    manifestDigest: digest,
    verification: z
      .object({
        checkedArtifacts: z.number().int().positive(),
        verifiedArtifacts: z.number().int().positive(),
        minimumIndependentGateways: z.number().int().min(2),
        artifacts: z.array(
          z
            .object({
              name: z.string(),
              cid,
              verified: z.literal(true),
              matchedGateways: z.array(z.string().url()).min(2),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .strict();

/** @param {Buffer | string} value */
function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(repoRoot: string, filePath: string): string {
  const path = relative(repoRoot, filePath);
  if (path === "" || path.startsWith("..")) {
    throw new Error(`RAG promotion evidence is outside the repository: ${filePath}`);
  }
  return path;
}

async function readJson(path: string): Promise<{ bytes: Buffer; value: unknown }> {
  const bytes = await readFile(path);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function assertCompleteVerification(
  report: z.infer<typeof verificationSchema>["verification"],
  manifest: z.infer<typeof manifestSchema>,
  manifestCid: string,
): void {
  if (
    report.checkedArtifacts !== report.verifiedArtifacts ||
    report.artifacts.length !== report.checkedArtifacts
  ) {
    throw new Error("RAG promotion requires verification of every published artifact");
  }
  for (const artifact of report.artifacts) {
    const hosts = new Set(artifact.matchedGateways.map((url) => new URL(url).host.toLowerCase()));
    if (hosts.size < report.minimumIndependentGateways) {
      throw new Error("RAG promotion requires two independent gateway hosts per artifact");
    }
  }
  const expected = new Map([
    ...manifest.artifacts
      .filter((artifact) => artifact.codec === "file")
      .map((artifact) => [artifact.name, artifact.cid] as const),
    ["manifest.json", manifestCid] as const,
  ]);
  if (expected.size !== report.checkedArtifacts) {
    throw new Error("RAG promotion verification count does not cover the whole manifest");
  }
  for (const artifact of report.artifacts) {
    if (expected.get(artifact.name) !== artifact.cid) {
      throw new Error(
        `RAG promotion verification does not match manifest artifact ${artifact.name}`,
      );
    }
    expected.delete(artifact.name);
  }
  if (expected.size !== 0) {
    throw new Error("RAG promotion verification omitted manifest artifacts");
  }
}

export interface PromotionOptions {
  runId: string;
  rootCid: string;
  repoRoot?: string;
  latestPath?: string;
  manifestPath?: string;
  verificationPath?: string;
  ledgerPath?: string;
  corpusSourcePath?: string;
  receiptPath?: string;
  indexPath?: string;
}

/** Validate all release evidence and construct the two deterministic receipts. */
export async function validatePublishedRelease(options: PromotionOptions): Promise<{
  promotionReceipt: z.infer<typeof promotionReceiptSchema>;
  corpusSource: z.infer<typeof corpusSourceSchema>;
}> {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const latestPath = resolve(options.latestPath ?? resolve(repoRoot, "artifacts/latest.json"));
  const manifestPath = resolve(
    options.manifestPath ?? resolve(repoRoot, `artifacts/manifest-${options.runId}.json`),
  );
  const verificationPath = resolve(
    options.verificationPath ?? resolve(repoRoot, `artifacts/verification-${options.runId}.json`),
  );
  const ledgerPath = resolve(
    options.ledgerPath ?? resolve(repoRoot, "artifacts/publication-attempts.json"),
  );
  const runDirectory = `pipeline/data/artifacts/publish/lake/runs/${options.runId}`;
  const runDir = resolve(repoRoot, runDirectory);

  const [latestFile, manifestFile, verificationFile, ledgerFile] = await Promise.all([
    readJson(latestPath),
    readJson(manifestPath),
    readJson(verificationPath),
    readJson(ledgerPath),
  ]);
  const latest = latestSchema.parse(latestFile.value);
  const manifest = manifestSchema.parse(manifestFile.value);
  const verification = verificationSchema.parse(verificationFile.value);
  if (
    latest.runId !== options.runId ||
    latest.rootCid !== options.rootCid ||
    latest.resolvedCid !== options.rootCid
  ) {
    throw new Error("latest.json does not identify the explicitly requested finalized run/root");
  }
  if (
    manifest.runId !== options.runId ||
    manifest.root.cid !== options.rootCid ||
    verification.runId !== options.runId ||
    verification.rootCid !== options.rootCid ||
    verification.manifestCid !== latest.manifestCid ||
    verification.mode !== latest.mode ||
    verification.candidateWorkflowRunId !== latest.candidateWorkflowRunId
  ) {
    throw new Error("manifest, verification and latest pointer do not share one release identity");
  }
  const manifestDigest = `sha256:${sha256(manifestFile.bytes)}`;
  if (manifestDigest !== verification.manifestDigest) {
    throw new Error("verification receipt does not bind the exact artifact manifest bytes");
  }
  assertCompleteVerification(verification.verification, manifest, latest.manifestCid);

  const ledger = z
    .object({ attempts: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(ledgerFile.value);
  const finalized = Object.entries(ledger.attempts).filter(([, value]) => {
    if (typeof value !== "object" || value === null) return false;
    const attempt = value as Record<string, unknown>;
    const target = attempt.target as Record<string, unknown> | undefined;
    const transitions = attempt.transitions as
      Array<{ stage?: unknown; receipt?: { rootCid?: unknown } }> | undefined;
    const finalTransition = transitions?.at(-1);
    return (
      attempt.state === "FINALIZED" &&
      finalTransition?.stage === "FINALIZED" &&
      finalTransition.receipt?.rootCid === options.rootCid &&
      target?.runId === options.runId &&
      target.rootCid === options.rootCid &&
      target.manifestDigest === manifestDigest &&
      target.mode === latest.mode &&
      target.candidateWorkflowRunId === latest.candidateWorkflowRunId
    );
  });
  if (finalized.length !== 1) {
    throw new Error(
      "publication ledger does not contain exactly one FINALIZED exact-identity attempt",
    );
  }
  const [attemptId] = finalized[0] as [string, unknown];

  const manifestFiles = new Map(
    manifest.artifacts
      .filter((artifact) => artifact.codec === "file")
      .map((artifact) => [artifact.name, artifact]),
  );
  const artifacts: { name: string; sha256: string }[] = [];
  for (const name of requiredArtifacts) {
    const manifestEntry = manifestFiles.get(name);
    if (!manifestEntry) throw new Error(`artifact manifest is missing RAG input ${name}`);
    const actual = sha256(await readFile(resolve(runDir, name)));
    if (manifestEntry.sha256 !== `sha256:${actual}`) {
      throw new Error(`local RAG input ${name} does not match the finalized manifest`);
    }
    artifacts.push({ name, sha256: actual });
  }

  const evidence = [
    { role: "latest" as const, path: latestPath, bytes: latestFile.bytes },
    { role: "manifest" as const, path: manifestPath, bytes: manifestFile.bytes },
    { role: "verification" as const, path: verificationPath, bytes: verificationFile.bytes },
    { role: "publication-ledger" as const, path: ledgerPath, bytes: ledgerFile.bytes },
  ].map(({ role, path, bytes }) => ({
    role,
    path: repositoryPath(repoRoot, path),
    sha256: sha256(bytes),
  }));

  const promotionReceipt = promotionReceiptSchema.parse({
    schemaVersion: "oracle.rag-promotion.v1",
    county: "lake",
    runId: options.runId,
    rootCid: options.rootCid,
    manifestCid: latest.manifestCid,
    manifestDigest,
    mode: latest.mode,
    candidateWorkflowRunId: latest.candidateWorkflowRunId,
    publishedAt: latest.publishedAt,
    publicationAttemptId: attemptId,
    publicationState: "FINALIZED",
    evidence,
    artifacts,
  });
  const receiptPath = resolve(
    options.receiptPath ?? resolve(repoRoot, "packages/rag/promotion-receipt.json"),
  );
  const corpusSource = corpusSourceSchema.parse({
    schemaVersion: "oracle.rag-corpus-source.v1",
    county: "lake",
    runId: options.runId,
    releaseState: "published",
    runDirectory,
    rootCid: options.rootCid,
    releaseReceipt: repositoryPath(repoRoot, receiptPath),
    artifacts,
  });
  return { promotionReceipt, corpusSource };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Validate first, then atomically switch the receipt and rebuild the explicit index. */
export async function promotePublishedCorpus(options: PromotionOptions): Promise<{
  receiptPath: string;
  corpusSourcePath: string;
  indexPath: string;
  chunks: number;
}> {
  const validated = await validatePublishedRelease(options);
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const receiptPath = resolve(
    options.receiptPath ?? resolve(repoRoot, "packages/rag/promotion-receipt.json"),
  );
  const corpusSourcePath = resolve(options.corpusSourcePath ?? CORPUS_SOURCE_PATH);
  const indexPath = resolve(options.indexPath ?? INDEX_PATH);
  const originals = await Promise.all(
    [receiptPath, corpusSourcePath, indexPath].map(async (path) => {
      try {
        return await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }),
  );
  try {
    await writeJsonAtomic(receiptPath, validated.promotionReceipt);
    await writeJsonAtomic(corpusSourcePath, validated.corpusSource);
    const { index } = await writeIndex(indexPath, options.runId);
    return {
      receiptPath,
      corpusSourcePath,
      indexPath,
      chunks: index.chunks.length,
    };
  } catch (error) {
    await Promise.all(
      [receiptPath, corpusSourcePath, indexPath].map((path, index) =>
        originals[index] === null
          ? rm(path, { force: true })
          : writeFile(path, originals[index] as Buffer),
      ),
    );
    throw error;
  }
}
