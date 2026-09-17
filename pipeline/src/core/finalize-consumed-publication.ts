/** Local receipt repair only. No upload, pin, approval consumption or IPNS writer. */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateArtifactManifest } from "./artifact-manifest.mjs";
import { computeRawCid } from "./cid.mjs";
import { appendRun, readRunHistory, validateRunRecord } from "./run-history.mjs";
import {
  advancePublicationAttempt,
  readPublicationLedger,
  sha256Digest,
  verifyConsumedPublicationResume,
} from "./publish-gate.mjs";
import { assertSecondaryRetention } from "./secondary-pin.mjs";

type Pointer = { networkKey: string; cid: string; sequence: number } | null;
export interface LocalFinalizationOptions {
  repoRoot: string;
  attemptId: string;
  authorization: unknown;
  publicKeyPem?: string | Buffer | null;
  expectedCandidateCommit: string;
  readPointer: () => Promise<Pointer>;
  readHashes: (parquetPath: string) => Promise<Map<string, string>>;
  now?: string;
}

const gatewayResult = z
  .object({
    gateway: z.string().url(),
    ok: z.boolean(),
    status: z.number().int().nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    sha256: z.string().nullable(),
    responseUrl: z.string().url().optional(),
  })
  .passthrough();
const verificationSchema = z
  .object({
    checkedArtifacts: z.number().int().positive(),
    verifiedArtifacts: z.number().int().positive(),
    minimumIndependentGateways: z.number().int().min(2),
    artifacts: z.array(
      z
        .object({
          name: z.string(),
          cid: z.string(),
          verified: z.literal(true),
          matchedGateways: z.array(z.string().url()),
          results: z.array(gatewayResult),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const evidenceSchema = z
  .object({
    runId: z.string(),
    mode: z.enum(["full", "incremental"]),
    candidateWorkflowRunId: z.string(),
    candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
    rootCid: z.string(),
    manifestCid: z.string(),
    manifestDigest: z.string(),
    verification: verificationSchema,
  })
  .strict();
const historyReceiptSchema = z
  .object({
    runRecord: z.unknown(),
    verificationEvidence: z.string(),
    verificationDigest: z.string(),
  })
  .strict();
const pointerSchema = z
  .object({ networkKey: z.string(), cid: z.string(), sequence: z.number().int().nonnegative() })
  .strict();
// The legacy ledger validator also reads older, less detailed targets. Local
// repair deliberately requires the fully bound modern consumed contract.
const consumedTargetSchema = z
  .object({
    county: z.string(),
    runId: z.string(),
    mode: z.enum(["full", "incremental"]),
    candidateWorkflowRunId: z.string(),
    candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
    rootCid: z.string(),
    manifestDigest: z.string(),
    ipnsNetworkKey: z.string(),
    executionScope: z.literal("replication-only").optional(),
    primaryCars: z
      .object({
        manifest: z.object({ cid: z.string() }).passthrough(),
        archive: z.object({ cid: z.string() }).passthrough(),
      })
      .passthrough(),
    secondaryPin: z.object({ provider: z.enum(["pinata", "lighthouse"]) }).passthrough(),
    ipnsPredecessor: z
      .object({ cid: z.string(), sequence: z.number().int().nonnegative() })
      .strict(),
  })
  .passthrough();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function assertSame(actual: unknown, expected: unknown, message: string): void {
  if (canonical(actual) !== canonical(expected)) throw new Error(message);
}

async function atomicWrite(file: string, value: unknown, pretty = false): Promise<void> {
  const temporary = `${file}.${process.pid}.finalize.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, "utf8");
  await rename(temporary, file);
}

/** Completes only the thirteenth, local transition of an already consumed attempt. */
export async function finalizeConsumedPublication(options: LocalFinalizationOptions) {
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(options.expectedCandidateCommit);
  const root = path.resolve(options.repoRoot);
  const artifacts = path.join(root, "artifacts");
  const ledgerPath = path.join(artifacts, "publication-attempts.json");
  const historyPath = path.join(artifacts, "run-history.json");
  const ledger = await readPublicationLedger(ledgerPath);
  const attempt = verifyConsumedPublicationResume(
    ledger,
    options.attemptId,
    options.authorization,
    options.publicKeyPem ?? null,
    { now: options.now },
  );
  const target = consumedTargetSchema.parse(attempt.target);
  if (
    target.executionScope === "replication-only" ||
    target.county !== "lake" ||
    target.candidateCommit !== options.expectedCandidateCommit
  ) {
    throw new Error(
      "Local finalization requires the exact consumed Lake publication execution commit",
    );
  }
  const receipt = historyReceiptSchema.parse(
    attempt.transitions.find((transition) => transition.stage === "HISTORY_RECORDED")?.receipt,
  );
  const record = validateRunRecord(receipt.runRecord);
  // Parsing must not silently normalize or invent the durable history evidence.
  assertSame(record, receipt.runRecord, "Durable history receipt changes under validation");
  assertSame(
    {
      runId: record.runId,
      mode: record.mode,
      candidateWorkflowRunId: record.candidateWorkflowRunId,
      candidateCommit: record.candidateCommit,
      rootCid: record.rootCid,
      manifestCid: record.manifestCid,
      carCid: record.carCid,
      ipnsName: record.ipnsName,
      resolvedCid: record.resolvedCid,
      status: record.status,
    },
    {
      runId: target.runId,
      mode: target.mode,
      candidateWorkflowRunId: target.candidateWorkflowRunId,
      candidateCommit: target.candidateCommit,
      rootCid: target.rootCid,
      manifestCid: target.primaryCars.manifest.cid,
      carCid: target.primaryCars.archive?.cid,
      ipnsName: target.ipnsNetworkKey,
      resolvedCid: target.rootCid,
      status: "succeeded",
    },
    "Durable history does not match the consumed publication target",
  );
  const expectedEvidencePath = `artifacts/verification-${target.runId}.json`;
  if (receipt.verificationEvidence !== expectedEvidencePath)
    throw new Error("Unexpected verification evidence path");
  const evidenceBytes = await readFile(path.join(root, expectedEvidencePath));
  if (sha256Digest(evidenceBytes) !== receipt.verificationDigest)
    throw new Error("Verification evidence digest mismatch");
  const evidence = evidenceSchema.parse(JSON.parse(evidenceBytes.toString("utf8")));
  assertSame(
    { ...evidence, verification: undefined },
    {
      runId: target.runId,
      mode: target.mode,
      candidateWorkflowRunId: target.candidateWorkflowRunId,
      candidateCommit: target.candidateCommit,
      rootCid: target.rootCid,
      manifestCid: target.primaryCars.manifest.cid,
      manifestDigest: target.manifestDigest,
      verification: undefined,
    },
    "Verification evidence identity mismatch",
  );
  assertSame(
    evidence.verification,
    attempt.transitions.find((transition) => transition.stage === "VERIFIED")?.receipt,
    "Verification report differs from durable verified receipt",
  );
  const manifestBytes = await readFile(path.join(artifacts, `manifest-${target.runId}.json`));
  if (
    sha256Digest(manifestBytes) !== target.manifestDigest ||
    computeRawCid(manifestBytes) !== target.primaryCars.manifest.cid
  )
    throw new Error("Manifest digest/CID mismatch");
  const manifest = validateArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (
    manifest.runId !== record.runId ||
    manifest.county !== target.county ||
    manifest.root.cid !== target.rootCid ||
    manifest.root.car !== `ipfs://${record.carCid}`
  )
    throw new Error("Manifest publication root/CAR binding mismatch");
  const expectedArtifacts = [
    {
      name: "manifest.json",
      cid: record.manifestCid,
      size: manifestBytes.length,
      sha256: target.manifestDigest,
    },
    ...manifest.artifacts,
  ];
  const report = evidence.verification;
  if (
    report.checkedArtifacts !== expectedArtifacts.length ||
    report.verifiedArtifacts !== expectedArtifacts.length ||
    report.artifacts.length !== expectedArtifacts.length
  )
    throw new Error("Verification omits eligible manifest artifacts");
  const verifiedGateways = new Set<string>();
  for (const expected of expectedArtifacts) {
    const proofs = report.artifacts.filter(
      (proof) => proof.name === expected.name && proof.cid === expected.cid,
    );
    if (proofs.length !== 1)
      throw new Error(`Missing or duplicate verified artifact: ${expected.name}`);
    const proof = proofs[0]!;
    const hosts = new Set<string>();
    for (const result of proof.results) {
      if (!result.ok) continue;
      const gateway = new URL(result.gateway);
      if (
        gateway.protocol !== "https:" ||
        gateway.username ||
        gateway.password ||
        !proof.matchedGateways.includes(result.gateway) ||
        result.status !== 200 ||
        result.bytes !== expected.size ||
        result.sha256 !== expected.sha256
      )
        throw new Error(`Gateway bytes/digest mismatch: ${expected.name}`);
      if (result.responseUrl) {
        const response = new URL(result.responseUrl);
        if (response.origin !== gateway.origin || response.pathname !== `/ipfs/${expected.cid}`)
          throw new Error(`Gateway redirect identity mismatch: ${expected.name}`);
      }
      hosts.add(gateway.hostname.toLowerCase());
      verifiedGateways.add(result.gateway);
    }
    if (hosts.size < report.minimumIndependentGateways)
      throw new Error(`Independent gateway evidence missing: ${expected.name}`);
  }
  assertSame(
    [...verifiedGateways].sort(),
    [...record.verifiedGateways].sort(),
    "Durable history gateway evidence mismatch",
  );
  const secondary = z
    .object({ root: z.unknown(), manifest: z.unknown(), archive: z.unknown() })
    .strict()
    .parse(
      attempt.transitions.find((transition) => transition.stage === "SECONDARY_PIN_RECORDED")
        ?.receipt,
    );
  assertSecondaryRetention(
    [secondary.root, secondary.manifest, secondary.archive],
    target.secondaryPin.provider,
  );
  for (const [value, cid] of [
    [secondary.root, target.rootCid],
    [secondary.manifest, record.manifestCid],
    [secondary.archive, record.carCid],
  ]) {
    if (z.object({ cid: z.string() }).passthrough().parse(value).cid !== cid)
      throw new Error("Secondary retention CID mismatch");
  }
  const recordedPointer = pointerSchema.parse(
    attempt.transitions.find((transition) => transition.stage === "IPNS_VERIFIED")?.receipt,
  );
  assertSame(
    recordedPointer,
    {
      networkKey: target.ipnsNetworkKey,
      cid: target.rootCid,
      sequence: target.ipnsPredecessor.sequence + 1,
    },
    "Recorded IPNS verification does not match the consumed target",
  );
  const history = await readRunHistory(historyPath);
  const existing = history.runs.find((entry) => entry.runId === record.runId);
  if (existing)
    assertSame(
      existing,
      record,
      `Run ${record.runId} exists with different immutable history evidence`,
    );
  if (attempt.state === "FINALIZED") {
    if (!existing) throw new Error("Finalized attempt is missing its immutable history record");
    const terminal = attempt.transitions.at(-1)?.receipt;
    assertSame(
      terminal,
      { runHistory: path.relative(root, historyPath), rootCid: target.rootCid },
      "Finalized local receipt mismatch",
    );
    return { runRecord: record, attempt, repaired: false };
  }
  // Only a read-only pointer callback is permitted. Never repoint an old run
  // when another publication has already advanced the mutable name.
  assertSame(
    await options.readPointer(),
    recordedPointer,
    "Current read-only IPNS state differs from the verified consumed publication",
  );
  const latestPath = path.join(artifacts, "latest.json");
  let latest: unknown = null;
  try {
    latest = JSON.parse(await readFile(latestPath, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (latest !== null) {
    const current = z
      .object({ runId: z.string(), publishedAt: z.string() })
      .passthrough()
      .parse(latest);
    if (
      current.runId !== record.runId &&
      Date.parse(current.publishedAt) >= Date.parse(record.finishedAt)
    )
      throw new Error("A newer latest publication cannot be overwritten by local recovery");
  }
  const query = manifest.artifacts.find((artifact) => artifact.name === "query-table.parquet");
  if (!query) throw new Error("Manifest is missing the query-table artifact");
  const queryPath = path.join(
    root,
    "pipeline/data/artifacts/publish/lake/runs",
    record.runId,
    "query-table.parquet",
  );
  const queryBytes = await readFile(queryPath);
  if (
    queryBytes.length !== query.size ||
    `sha256:${createHash("sha256").update(queryBytes).digest("hex")}` !== query.sha256
  )
    throw new Error("Local query table does not match verified immutable bytes");
  const hashes = await options.readHashes(queryPath);
  const properties = record.tables.find((table) => table.name === "properties");
  if (
    !properties ||
    hashes.size !== properties.rows ||
    [...hashes].some(([id, hash]) => !id || !/^[a-f0-9]{32}$/.test(hash))
  )
    throw new Error("Local row-hash baseline does not reconcile to the durable property count");
  // Validate every binding before the first write. History precedes its cache.
  if (!existing) await appendRun(historyPath, record);
  await atomicWrite(path.join(artifacts, "row-hashes.json"), {
    runId: record.runId,
    hashes: Object.fromEntries(hashes),
  });
  await atomicWrite(
    latestPath,
    {
      runId: record.runId,
      mode: record.mode,
      candidateWorkflowRunId: record.candidateWorkflowRunId,
      candidateCommit: record.candidateCommit,
      rootCid: record.rootCid,
      manifestCid: record.manifestCid,
      carCid: record.carCid,
      ipnsName: record.ipnsName,
      resolvedCid: record.resolvedCid,
      verifiedGateways: record.verifiedGateways,
      propertyCount: properties.rows,
      publishedAt: record.finishedAt,
    },
    true,
  );
  const finalized = await advancePublicationAttempt(
    ledgerPath,
    options.attemptId,
    "FINALIZED",
    { runHistory: path.relative(root, historyPath), rootCid: target.rootCid },
    options.now ? { at: options.now } : {},
  );
  return { runRecord: record, attempt: finalized, repaired: true };
}
