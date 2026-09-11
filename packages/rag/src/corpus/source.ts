/**
 * Explicit selection and validation of the one run allowed into the corpus.
 *
 * Directory recency is not provenance. The receipt names one candidate and
 * hashes every run artifact used below, so a newer directory cannot silently
 * change the index and a changed artifact fails before it can inherit another
 * run's identity.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from either `src/corpus` or `dist/corpus`. */
export const REPO_ROOT = process.env.ORACLE_REPO_ROOT ?? resolve(here, "../../../..");
export const CORPUS_SOURCE_PATH = resolve(REPO_ROOT, "packages/rag/corpus-source.json");

const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const corpusSourceSchema = z
  .object({
    schemaVersion: z.literal("oracle.rag-corpus-source.v1"),
    county: z.literal("lake"),
    runId: z.string().regex(/^\d{8}T\d{6}Z$/),
    releaseState: z.enum(["local_candidate", "published"]),
    runDirectory: z.string(),
    rootCid: z.string().nullable(),
    releaseReceipt: z.string().nullable(),
    supersedes: z
      .object({
        runId: z.string(),
        reason: z.string(),
      })
      .nullable()
      .optional(),
    artifacts: z.array(
      z.object({
        name: z.string(),
        sha256: digest,
      }),
    ),
  })
  .superRefine((value, context) => {
    if (value.releaseState === "local_candidate" && value.rootCid !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rootCid"],
        message: "A local candidate cannot claim a public root CID",
      });
    }
    if (value.releaseState === "published" && (value.rootCid === null || !value.releaseReceipt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["releaseReceipt"],
        message: "A published corpus requires both rootCid and an external release receipt",
      });
    }
  });

export type CorpusSource = z.infer<typeof corpusSourceSchema>;

export interface SelectedCorpusSource {
  receipt: CorpusSource;
  receiptPath: string;
  runDir: string;
  artifactPaths: ReadonlyMap<string, string>;
  releaseReceiptPath: string | null;
}

export interface SourceInput {
  path: string;
  sha256: string;
}

export const promotionReceiptSchema = z
  .object({
    schemaVersion: z.literal("oracle.rag-promotion.v1"),
    county: z.literal("lake"),
    runId: z.string(),
    rootCid: z.string(),
    manifestCid: z.string(),
    manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mode: z.enum(["full", "incremental"]),
    candidateWorkflowRunId: z.string(),
    publishedAt: z.string().datetime({ offset: true }),
    publicationAttemptId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    publicationState: z.literal("FINALIZED"),
    evidence: z.array(
      z
        .object({
          role: z.enum(["latest", "manifest", "verification", "publication-ledger"]),
          path: z.string(),
          sha256: digest,
        })
        .strict(),
    ),
    artifacts: z.array(z.object({ name: z.string(), sha256: digest }).strict()),
  })
  .strict();

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function repositoryPath(path: string): string {
  const value = relative(REPO_ROOT, path);
  if (value.startsWith("..") || value === "")
    throw new Error(`Corpus input is outside repo: ${path}`);
  return value;
}

/** Read the explicit source receipt and verify every selected artifact byte. */
export async function selectCorpusSource(
  expectedRunId?: string,
  receiptPath = CORPUS_SOURCE_PATH,
): Promise<SelectedCorpusSource> {
  const receipt = corpusSourceSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
  if (expectedRunId !== undefined && receipt.runId !== expectedRunId) {
    throw new Error(
      `Corpus receipt selects ${receipt.runId}, but build requested ${expectedRunId}; refusing drift`,
    );
  }

  const publishRuns = resolve(REPO_ROOT, "pipeline/data/artifacts/publish/lake/runs");
  const runDir = resolve(REPO_ROOT, receipt.runDirectory);
  if (!inside(publishRuns, runDir) || runDir.split(sep).at(-1) !== receipt.runId) {
    throw new Error(`Corpus runDirectory must name runs/${receipt.runId}`);
  }

  const names = new Set<string>();
  const artifactPaths = new Map<string, string>();
  for (const artifact of receipt.artifacts) {
    if (names.has(artifact.name)) throw new Error(`Duplicate corpus artifact: ${artifact.name}`);
    names.add(artifact.name);
    const path = resolve(runDir, artifact.name);
    if (!inside(runDir, path))
      throw new Error(`Corpus artifact escapes run directory: ${artifact.name}`);
    const actual = sha256(await readFile(path));
    if (actual !== artifact.sha256) {
      throw new Error(
        `Corpus artifact digest mismatch for ${artifact.name}: expected ${artifact.sha256}, got ${actual}`,
      );
    }
    artifactPaths.set(artifact.name, path);
  }

  const required = [
    "coverage.json",
    "index.json",
    "permit-schema.json",
    "schema.json",
    "samples/aged-roofs.json",
    "samples/open-roofing-permits.json",
    "samples/out-of-area-owners.json",
  ];
  for (const name of required) {
    if (!artifactPaths.has(name))
      throw new Error(`Corpus receipt is missing required artifact: ${name}`);
  }

  let releaseReceiptPath: string | null = null;
  if (receipt.releaseState === "published") {
    releaseReceiptPath = resolve(REPO_ROOT, receipt.releaseReceipt as string);
    if (!inside(REPO_ROOT, releaseReceiptPath)) {
      throw new Error("Published RAG release receipt must stay inside the repository");
    }
    const promotion = promotionReceiptSchema.parse(
      JSON.parse(await readFile(releaseReceiptPath, "utf8")),
    );
    if (
      promotion.runId !== receipt.runId ||
      promotion.rootCid !== receipt.rootCid ||
      canonicalArtifacts(promotion.artifacts) !== canonicalArtifacts(receipt.artifacts)
    ) {
      throw new Error("Published RAG release receipt does not match the selected corpus identity");
    }
    for (const evidence of promotion.evidence) {
      const evidencePath = resolve(REPO_ROOT, evidence.path);
      if (
        !inside(REPO_ROOT, evidencePath) ||
        sha256(await readFile(evidencePath)) !== evidence.sha256
      ) {
        throw new Error(`Published RAG release evidence digest mismatch: ${evidence.path}`);
      }
    }
  }

  return { receipt, receiptPath, runDir, artifactPaths, releaseReceiptPath };
}

function canonicalArtifacts(artifacts: readonly { name: string; sha256: string }[]): string {
  return JSON.stringify([...artifacts].sort((left, right) => left.name.localeCompare(right.name)));
}

/** Hash a sorted, repository-relative list of source-file digests. */
export async function buildSourceSnapshot(paths: readonly string[]): Promise<{
  digest: string;
  inputs: SourceInput[];
}> {
  const inputs: SourceInput[] = [];
  for (const path of [...new Set(paths)].sort()) {
    inputs.push({ path: repositoryPath(path), sha256: sha256(await readFile(path)) });
  }
  return {
    digest: `sha256:${sha256(JSON.stringify(inputs))}`,
    inputs,
  };
}
