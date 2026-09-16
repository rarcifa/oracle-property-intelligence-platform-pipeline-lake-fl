/**
 * Explicitly authorized external predecessor handoff. An observation is not a
 * historical publication success. Original approval/readback remain unknown.
 * Uses the existing publication Ed25519 primitive, never a new trust root.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { canonicalJson } from "./coverage-publication.mjs";
import { computeUnixfsFileCid } from "./cid.mjs";
import { validateArtifactManifest } from "./artifact-manifest.mjs";
import { publishedBusinessAccountRows } from "./run-history.mjs";
import {
  sha256Digest,
  signAuthorizationPayload,
  verifyAuthorizationSignature,
} from "./publish-gate.mjs";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cid = z.string().regex(/^b[a-z2-7]{20,}$/);
const timestamp = z.string().datetime({ offset: true });
const pointerSchema = z
  .object({
    networkKey: z.string().regex(/^k[a-z0-9]{20,}$/),
    cid,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const artifactSchema = z
  .object({ cid, size: z.number().int().positive(), sha256: digest })
  .strict();
const historySchema = z.object({ runId: z.string().min(1), rootCid: cid, sha256: digest }).strict();
const disclosureSchema = z
  .object({
    originalApproval: z.literal("unknown"),
    originalSuccessfulPublicationReceipt: z.literal("unknown"),
    historicalGatewayReadback: z.literal("unknown"),
  })
  .strict();
const targetSchema = z
  .object({
    county: z.literal("lake"),
    bucket: z.literal("elephant-oracle-open-data-lake"),
    ipnsLabel: z.literal("oracle-open-data-lake"),
    pointer: pointerSchema,
    producerRunId: z.string().regex(/^\d{8}T\d{6}Z$/),
    manifest: artifactSchema,
    evidenceDigest: digest,
    lastKnownHistory: historySchema,
    disclosure: disclosureSchema,
    candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
    provenanceDigest: digest,
    action: z.literal("recover-observed-predecessor-only"),
  })
  .strict();
const payloadSchema = z
  .object({
    schemaVersion: z.literal("elephant.predecessor-recovery-authorization.v1"),
    kind: z.literal("oracle-external-predecessor-recovery"),
    target: targetSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    approver: z.string().trim().min(1),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.expiresAt) > Date.parse(value.issuedAt),
    "expiresAt must follow issuedAt",
  );
const authorizationSchema = z
  .object({
    payload: payloadSchema,
    signature: z
      .object({ algorithm: z.literal("ed25519"), keyId: digest, value: z.string().min(1) })
      .strict(),
  })
  .strict();
const proofSchema = z
  .object({
    name: z.enum(["manifest", "/", "coverage.json", "query-table.parquet"]),
    cid,
    gateway: z.string().url(),
    fetchedAt: timestamp,
    bytes: z.number().int().positive(),
    sha256: digest,
  })
  .strict();
const evidenceSchema = z
  .object({
    schemaVersion: z.literal("elephant.observed-predecessor-evidence.v1"),
    observedAt: timestamp,
    county: z.literal("lake"),
    bucket: z.literal("elephant-oracle-open-data-lake"),
    ipnsLabel: z.literal("oracle-open-data-lake"),
    pointer: pointerSchema,
    producerRunId: z.string().regex(/^\d{8}T\d{6}Z$/),
    manifest: artifactSchema,
    artifacts: z
      .object({ root: artifactSchema, coverage: artifactSchema, query: artifactSchema })
      .strict(),
    lastKnownHistory: historySchema,
    disclosure: disclosureSchema,
    proofs: z.array(proofSchema).min(8),
    queryReconciliation: z
      .object({
        rows: z.number().int().positive(),
        distinctFolio: z.number().int().positive(),
        nullFolio: z.literal(0),
      })
      .strict(),
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal("elephant.external-predecessor-receipt.v1"),
    status: z.literal("externally_observed_recovered"),
    acceptedAt: timestamp,
    authorization: authorizationSchema,
    observedPointer: pointerSchema,
  })
  .strict();

export function buildRecoveryPayload(target, approval) {
  return payloadSchema.parse({
    schemaVersion: "elephant.predecessor-recovery-authorization.v1",
    kind: "oracle-external-predecessor-recovery",
    target: targetSchema.parse(target),
    ...approval,
  });
}
export function signRecoveryAuthorization(payload, privateKey) {
  return signAuthorizationPayload(payloadSchema.parse(payload), privateKey);
}
export function verifyRecoveryAuthorization(
  authorization,
  publicKey,
  expectedTarget,
  now = new Date().toISOString(),
) {
  const validated = authorizationSchema.parse(authorization);
  if (
    canonicalJson(validated.payload.target) !== canonicalJson(targetSchema.parse(expectedTarget))
  ) {
    throw new Error("Recovery authorization does not match the exact target");
  }
  if (
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(now) < Date.parse(validated.payload.issuedAt)
  ) {
    throw new Error("Recovery authorization is not active yet");
  }
  if (Date.parse(now) >= Date.parse(validated.payload.expiresAt)) {
    throw new Error("Recovery authorization has expired");
  }
  verifyAuthorizationSignature(validated, publicKey);
  return validated;
}
export function assertRecoveryPointer(expected, observed) {
  if (
    canonicalJson(pointerSchema.parse(expected)) !== canonicalJson(pointerSchema.parse(observed))
  ) {
    throw new Error("Observed predecessor IPNS name/root/sequence drifted; no recovery accepted");
  }
}

/** Validates ORIGINAL bytes, not a reconstructed JSON serialization. */
export function validateRecoveryPacket({
  evidenceBytes,
  manifestBytes,
  rootBytes,
  coverageBytes,
  queryBytes,
  historyBytes,
}) {
  const evidence = evidenceSchema.parse(JSON.parse(evidenceBytes.toString("utf8")));
  const check = (bytes, artifact) => {
    if (bytes.length !== artifact.size || sha256Digest(bytes) !== artifact.sha256) {
      throw new Error("Recovery artifact bytes/digest mismatch");
    }
  };
  check(manifestBytes, evidence.manifest);
  if (computeUnixfsFileCid(manifestBytes).cid !== evidence.manifest.cid)
    throw new Error("Manifest CID mismatch");
  const manifest = validateArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.runId !== evidence.producerRunId || manifest.root.cid !== evidence.pointer.cid) {
    throw new Error("Recovered manifest does not describe the observed predecessor");
  }
  const definitions = [
    ["/", rootBytes, evidence.artifacts.root],
    ["coverage.json", coverageBytes, evidence.artifacts.coverage],
    ["query-table.parquet", queryBytes, evidence.artifacts.query],
  ];
  for (const [name, bytes, artifact] of definitions) {
    check(bytes, artifact);
    const entry = manifest.artifacts.find((item) => item.name === name);
    if (
      !entry ||
      entry.cid !== artifact.cid ||
      entry.size !== artifact.size ||
      entry.sha256 !== artifact.sha256
    ) {
      throw new Error("Recovery artifact is not bound by the genuine producer manifest");
    }
    if (name !== "/" && computeUnixfsFileCid(bytes).cid !== artifact.cid)
      throw new Error("Artifact CID mismatch");
  }
  const rootCid = CID.parse(evidence.pointer.cid);
  if (
    rootCid.code !== 0x70 ||
    rootCid.multihash.code !== 0x12 ||
    Buffer.from(rootCid.multihash.digest).toString("hex") !== sha256Digest(rootBytes).slice(7)
  ) {
    throw new Error("Root block CID mismatch");
  }
  const root = dagPB.decode(rootBytes);
  for (const [name, , artifact] of definitions.slice(1)) {
    if (!root.Links.some((link) => link.Name === name && link.Hash.toString() === artifact.cid)) {
      throw new Error("Producer root does not link the recovered artifact");
    }
  }
  if (evidence.artifacts.root.cid !== evidence.pointer.cid)
    throw new Error("Root identity mismatch");
  const history = JSON.parse(historyBytes.toString("utf8"));
  const successful = history.runs
    .filter((run) => run.status === "succeeded")
    .sort((a, b) => a.runId.localeCompare(b.runId));
  const previous = successful.at(-1);
  if (
    !previous ||
    previous.runId !== evidence.lastKnownHistory.runId ||
    previous.rootCid !== evidence.lastKnownHistory.rootCid ||
    sha256Digest(historyBytes) !== evidence.lastKnownHistory.sha256
  ) {
    throw new Error("Immutable last-known publication history changed");
  }
  for (const [name, artifact] of [
    ["manifest", evidence.manifest],
    ...definitions.map(([name, , artifact]) => [name, artifact]),
  ]) {
    const matching = evidence.proofs.filter(
      (proof) =>
        proof.name === name &&
        proof.cid === artifact.cid &&
        proof.bytes === artifact.size &&
        proof.sha256 === artifact.sha256,
    );
    const hosts = new Set(
      matching.map((proof) => {
        const url = new URL(proof.gateway);
        if (
          url.protocol !== "https:" ||
          !["ipfs.filebase.io", "gw.ipfs-lens.dev"].includes(url.host)
        ) {
          throw new Error("Recovery evidence must name the approved independent public gateways");
        }
        if (Date.parse(proof.fetchedAt) > Date.parse(evidence.observedAt))
          throw new Error("Evidence predates its fetch");
        return url.host;
      }),
    );
    if (hosts.size < 2)
      throw new Error("Two independent readbacks required for every recovery artifact");
  }
  const coverage = JSON.parse(coverageBytes.toString("utf8"));
  if (
    coverage.county !== evidence.county ||
    !coverage.tables ||
    typeof coverage.tables !== "object"
  ) {
    throw new Error("Recovered coverage county/tables are incompatible");
  }
  for (const table of Object.values(coverage.tables)) {
    if (table?.rows !== undefined && (!Number.isSafeInteger(table.rows) || table.rows < 0)) {
      throw new Error("Recovered coverage rows must be non-negative safe integers");
    }
  }
  if (
    evidence.queryReconciliation.rows !== evidence.queryReconciliation.distinctFolio ||
    evidence.queryReconciliation.rows !== coverage.tables.properties?.rows
  ) {
    throw new Error("Recovered query rows/unique folios do not reconcile to producer coverage");
  }
  return { evidence, manifest, coverage };
}

function assertReceiptTime(receipt, now) {
  if (
    Date.parse(receipt.acceptedAt) < Date.parse(receipt.authorization.payload.issuedAt) ||
    Date.parse(receipt.acceptedAt) >= Date.parse(receipt.authorization.payload.expiresAt) ||
    Date.parse(receipt.acceptedAt) > Date.parse(now)
  )
    throw new Error("Recovery receipt acceptance time is invalid");
}

export function recoveryTarget(evidence, evidenceBytes, candidateCommit, provenanceDigest) {
  return targetSchema.parse({
    county: evidence.county,
    bucket: evidence.bucket,
    ipnsLabel: evidence.ipnsLabel,
    pointer: evidence.pointer,
    producerRunId: evidence.producerRunId,
    manifest: evidence.manifest,
    evidenceDigest: sha256Digest(evidenceBytes),
    lastKnownHistory: evidence.lastKnownHistory,
    disclosure: evidence.disclosure,
    candidateCommit,
    provenanceDigest,
    action: "recover-observed-predecessor-only",
  });
}
export function validateRecoveryHistory(originalBytes, liveBytes, allowedAppend = null) {
  if (originalBytes.equals(liveBytes)) return;
  const original = JSON.parse(originalBytes.toString("utf8"));
  const live = JSON.parse(liveBytes.toString("utf8"));
  const { runs: originalRuns, ...originalMetadata } = original;
  const { runs: liveRuns, ...liveMetadata } = live;
  if (
    !allowedAppend ||
    allowedAppend.status !== "succeeded" ||
    !Array.isArray(originalRuns) ||
    !Array.isArray(liveRuns) ||
    canonicalJson(originalMetadata) !== canonicalJson(liveMetadata) ||
    canonicalJson(liveRuns) !== canonicalJson([allowedAppend, ...originalRuns])
  ) {
    throw new Error("Live history drift is not the exact durable publication append");
  }
}
export async function readRecoveryPacket(inputDir, historyPath, allowedHistoryAppend = null) {
  const [evidenceBytes, manifestBytes, rootBytes, coverageBytes, queryBytes, historyBytes] =
    await Promise.all(
      [
        "evidence.json",
        "producer-manifest.json",
        "root.block",
        "coverage.json",
        "query-table.parquet",
        "last-known-history.json",
      ].map((file) => readFile(path.join(inputDir, file))),
    );
  validateRecoveryHistory(historyBytes, await readFile(historyPath), allowedHistoryAppend);
  const packet = {
    evidenceBytes,
    manifestBytes,
    rootBytes,
    coverageBytes,
    queryBytes,
    historyBytes,
  };
  return { ...packet, ...validateRecoveryPacket(packet) };
}

/** A local consumer receipt only; never edits run-history or a remote pointer. */
export async function acceptRecovery({
  inputDir,
  historyPath,
  authorization,
  publicKey,
  readPointer,
  now = new Date().toISOString(),
}) {
  const packet = await readRecoveryPacket(inputDir, historyPath);
  const candidate = authorizationSchema.parse(authorization);
  const target = recoveryTarget(
    packet.evidence,
    packet.evidenceBytes,
    candidate.payload.target.candidateCommit,
    candidate.payload.target.provenanceDigest,
  );
  const validated = verifyRecoveryAuthorization(candidate, publicKey, target, now);
  const observedPointer = await readPointer();
  assertRecoveryPointer(target.pointer, observedPointer);
  const receiptPath = path.join(inputDir, "recovery-receipt.json");
  const receipt = receiptSchema.parse({
    schemaVersion: "elephant.external-predecessor-receipt.v1",
    status: "externally_observed_recovered",
    acceptedAt: now,
    authorization: validated,
    observedPointer,
  });
  try {
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = receiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
    if (canonicalJson(existing.authorization) !== canonicalJson(validated))
      throw new Error("Recovery receipt replay/overwrite rejected");
    assertRecoveryPointer(target.pointer, existing.observedPointer);
    assertReceiptTime(existing, now);
    return existing;
  }
  return receipt;
}

/** Verify signature + all immutable handoff bytes again before publisher use. */
export async function loadRecoveryAnchor({
  receiptPath,
  publicKey,
  historyPath,
  now = new Date().toISOString(),
  allowedHistoryAppend = null,
}) {
  const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
  const packet = await readRecoveryPacket(
    path.dirname(receiptPath),
    historyPath,
    allowedHistoryAppend,
  );
  const target = recoveryTarget(
    packet.evidence,
    packet.evidenceBytes,
    receipt.authorization.payload.target.candidateCommit,
    receipt.authorization.payload.target.provenanceDigest,
  );
  // A separately verified consumed publication may reconcile local receipts
  // after expiry, but cannot authorize fresh remote effects.
  verifyRecoveryAuthorization(
    receipt.authorization,
    publicKey,
    target,
    allowedHistoryAppend ? receipt.acceptedAt : now,
  );
  assertRecoveryPointer(target.pointer, receipt.observedPointer);
  assertReceiptTime(receipt, now);
  return {
    rootCid: target.pointer.cid,
    runId: target.producerRunId,
    pointer: target.pointer,
    receiptDigest: sha256Digest(Buffer.from(canonicalJson(receipt))),
    queryPath: path.join(path.dirname(receiptPath), "query-table.parquet"),
    tables: Object.entries(packet.coverage.tables)
      .filter(([, table]) => Number.isSafeInteger(table?.rows))
      .map(([name, table]) => ({
        name,
        rows: name === "businessAccounts" ? publishedBusinessAccountRows(table) : table.rows,
      })),
    disclosure: target.disclosure,
  };
}
