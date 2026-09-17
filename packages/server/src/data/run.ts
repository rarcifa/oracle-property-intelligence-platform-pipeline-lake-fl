/**
 * Run metadata: matching coverage, the latest pointer, and exact-run receipts.
 *
 * Files are read at request time so new receipts show up without a restart.
 * A held latest pointer cannot donate identity to another served snapshot;
 * separately bound gateway observations may describe that snapshot without
 * claiming finalized publication, retention or source-semantic readiness.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LatestRunPointer, RunPublicationEvidence } from "@oracle-lake/shared";
import { z } from "zod";
import type { ServerConfig } from "../config.js";

export interface CoverageSnapshot {
  schemaVersion: string;
  county: string;
  countyName: string;
  stateCode: string;
  countyFips: string;
  runId: string;
  exportedAt: string;
  denominator: { basis: string; source: string; assessedParcelCount: number };
  tables: Record<string, { rows: number; source: string }>;
  signals: Record<string, number>;
  limitations: string[];
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Read the published coverage snapshot for the configured run. */
export async function readCoverage(config: ServerConfig): Promise<CoverageSnapshot | null> {
  if (config.localEvidencePreview) return null;
  if (config.runDir === null) return null;
  return readJson<CoverageSnapshot>(resolve(config.runDir, "coverage.json"));
}

/** Read the published-run pointer, when the run has been published. */
export async function readLatest(config: ServerConfig): Promise<LatestRunPointer | null> {
  if (config.localEvidencePreview) return null;
  return readJson<LatestRunPointer>(config.latestPath);
}

/** Read the published schema descriptor for the run, when present. */
export async function readPublishedSchema(
  config: ServerConfig,
): Promise<{ columnCount: number; columns: { name: string; type: string }[] } | null> {
  if (config.localEvidencePreview) return null;
  if (config.runDir === null) return null;
  return readJson(resolve(config.runDir, "schema.json"));
}

/** Identity of the run currently being served. */
export interface RunIdentity {
  runId: string | null;
  rootCid: string | null;
}

/** Best-effort run identity, preferring the published pointer. */
export async function readRunIdentity(
  config: ServerConfig,
  servedRootCid: string | null,
): Promise<RunIdentity> {
  if (config.localEvidencePreview) return { runId: config.dataRunId, rootCid: null };
  if (config.dataRunId !== null) {
    return { runId: config.dataRunId, rootCid: config.dataRootCid };
  }
  // A local Parquet and its sibling coverage snapshot are one candidate. A
  // previously published `latest.json` may describe different bytes and must
  // never donate its run id or root CID to the local table.
  if (config.parquetSourceKind === "local" && servedRootCid === null) {
    const coverage = await readCoverage(config);
    if (coverage) return { runId: coverage.runId, rootCid: null };
    return { runId: null, rootCid: null };
  }
  const latest = await readLatest(config);
  if (servedRootCid !== null && latest?.rootCid === servedRootCid) {
    return { runId: latest.runId, rootCid: latest.rootCid };
  }
  return { runId: null, rootCid: servedRootCid };
}

/** One artifact's cross-gateway verification result. */
export interface ArtifactVerification {
  name: string;
  cid: string;
  verified: boolean;
  matchedGateways: string[];
  minimumIndependentGateways: number;
  results: {
    gateway: string;
    ok: boolean;
    status: number | null;
    bytes: number | null;
    sha256: string | null;
    error: string | null;
  }[];
}

/** `artifacts/verification-<runId>.json`. */
export interface VerificationReport {
  runId: string;
  rootCid: string;
  verifications: ArtifactVerification[];
}

/** `artifacts/run-history.json`. */
export interface RunHistory {
  schemaVersion: string;
  runs: Record<string, unknown>[];
}

/** Directory holding the published-run evidence files. */
export function artifactsDir(config: ServerConfig): string {
  return dirname(config.latestPath);
}

/**
 * Read the cross-gateway verification report for a run.
 *
 * This is the evidence that the published CIDs actually resolve to the same
 * bytes from independent gateways, which is what makes "immutably published"
 * checkable rather than claimed.
 */
export async function readVerification(
  config: ServerConfig,
  runId: string | null,
): Promise<VerificationReport | null> {
  if (config.localEvidencePreview) return null;
  if (runId === null) return null;
  const report = await readJson<VerificationReport>(
    resolve(artifactsDir(config), `verification-${runId}.json`),
  );
  // Current protocol reports are nested and must pass the finalized receipt
  // binding below. Never pass an unnormalized object to the table renderer.
  return Array.isArray(report?.verifications) ? report : null;
}

/** Read the publish history, when present. */
export async function readRunHistory(config: ServerConfig): Promise<RunHistory | null> {
  if (config.localEvidencePreview) return null;
  return readJson<RunHistory>(resolve(artifactsDir(config), "run-history.json"));
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const artifactSchema = z.object({
  name: z.string(),
  cid: z.string().min(3),
  size: z.number().int().nonnegative(),
  codec: z.enum(["file", "directory"]),
  sha256: digestSchema,
});
const gatewayProofSchema = z.object({
  cid: z.string(),
  verified: z.boolean(),
  matchedGateways: z.array(z.string()),
  minimumIndependentGateways: z.number().int().min(2).default(2),
  results: z.array(
    z.object({
      gateway: z.string(),
      ok: z.boolean(),
      status: z.number().nullable(),
      bytes: z.number().nullable(),
      sha256: z.string().nullable(),
      error: z.string().nullable(),
      responseUrl: z.string().optional(),
    }),
  ),
});
const manifestSchema = z.object({
  schemaVersion: z.literal("elephant.artifact-manifest.v1"),
  runId: z.string(),
  root: z.object({ cid: z.string(), car: z.string() }),
  artifacts: z.array(artifactSchema).min(1),
  directoryCars: z.array(z.object({ directoryCid: z.string(), carCid: z.string() })),
});
const inventorySchema = z.object({
  schemaVersion: z.literal("oracle.recorded-public-gateway-inventory.v1"),
  runId: z.string(),
  assembledAt: z.string().datetime(),
  manifest: z.string(),
  manifestSha256: digestSchema,
  listedObjects: z.number().int().positive(),
  allListedObjectsVerified: z.literal(true),
  retentionVerified: z.literal(false),
  publicationPromoted: z.literal(false),
  sourceReceipts: z.array(z.string()).min(1),
  manifestSelfProof: gatewayProofSchema,
  artifacts: z.array(
    artifactSchema.extend({
      receipt: z.string(),
      matchedGateways: z.array(z.string()),
    }),
  ),
});
const readbackSchema = z.object({
  runId: z.string(),
  manifestBytes: z.number(),
  manifestSha256: digestSchema,
  manifestObject: gatewayProofSchema,
  listedArtifacts: z.object({
    runId: z.string(),
    artifacts: z.array(gatewayProofSchema.extend({ name: z.string() })),
  }),
});
const archiveReceiptSchema = z.object({
  runId: z.string(),
  artifact: artifactSchema,
  verification: gatewayProofSchema,
});
const normalVerificationSchema = z.object({
  checkedArtifacts: z.number().int().positive(),
  verifiedArtifacts: z.number().int().positive(),
  minimumIndependentGateways: z.number().int().min(2),
  artifacts: z.array(gatewayProofSchema.extend({ name: z.string() })),
});
const normalReportSchema = z.object({
  runId: z.string(),
  rootCid: z.string(),
  manifestCid: z.string(),
  manifestDigest: digestSchema,
  verification: normalVerificationSchema,
});
const retainedCopySchema = z.object({
  provider: z.literal("lighthouse"),
  serviceHost: z.literal("api.lighthouse.storage"),
  cid: z.string(),
  name: z.string(),
  status: z.literal("retention-evidence-verified"),
  retentionVerified: z.literal(true),
  requestAccepted: z.object({
    state: z.literal("request-accepted"),
    httpStatus: z.number().int().min(200).max(299),
    requestId: z.string().min(1),
    responseDigest: digestSchema,
  }),
  registration: z.object({
    id: z.string().min(1),
    cid: z.string(),
    fileName: z.string(),
    fileSizeInBytes: z.number().int().nonnegative(),
    encryption: z.literal(false),
  }),
  metadata: z.object({
    cid: z.string(),
    fileSizeInBytes: z.number().int().nonnegative(),
    encryption: z.literal(false),
  }),
  publicGateway: z
    .object({
      host: z.literal("gateway.lighthouse.storage"),
      cid: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
      car: z
        .object({
          roots: z.array(z.string()).min(1),
          verifiedBlocks: z.number().int().positive(),
        })
        .optional(),
    })
    .optional(),
  retentionEvidence: z
    .object({
      coveredBy: z.literal("lighthouse-snapshot-car"),
      archiveCid: z.string(),
      expectedRoots: z.array(z.string()).min(1),
    })
    .optional(),
});
const secondaryRetentionSchema = z.object({
  root: retainedCopySchema,
  manifest: retainedCopySchema,
  archive: retainedCopySchema,
});
const finalizedAttemptSchema = z.object({
  target: z.object({
    runId: z.string(),
    rootCid: z.string(),
    manifestDigest: digestSchema,
    executionScope: z.string().optional(),
    primaryCars: z.object({
      root: z.object({ cid: z.string() }),
      manifest: z.object({ cid: z.string() }),
      archive: z.object({ cid: z.string() }),
    }),
    secondaryPin: z.object({
      provider: z.literal("lighthouse"),
      rootPinName: z.string(),
      manifestPinName: z.string(),
      archivePinName: z.string(),
    }),
  }),
  state: z.string(),
  transitions: z.array(
    z.object({
      sequence: z.number().int(),
      stage: z.string(),
      at: z.string().datetime(),
      receipt: z.unknown(),
    }),
  ),
});

const FINALIZED_STAGES = [
  "PREPARED",
  "FROZEN",
  "BUILT",
  "AUTHORIZED",
  "ROOT_UPLOAD_RECORDED",
  "MANIFEST_UPLOAD_RECORDED",
  "SECONDARY_PIN_RECORDED",
  "VERIFIED",
  "HISTORY_RECORDED",
  "IPNS_REPOINT_RECORDED",
  "IPNS_VERIFIED",
  "APPROVAL_CONSUMED",
  "FINALIZED",
];

type ManifestArtifact = z.infer<typeof artifactSchema>;
type GatewayProof = z.infer<typeof gatewayProofSchema>;

function gatewayOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Re-check recorded observations, not merely their optimistic success flags. */
function verifiedArtifact(
  artifact: ManifestArtifact,
  proof: GatewayProof,
): ArtifactVerification | null {
  if (!proof.verified || proof.cid !== artifact.cid) return null;
  const claimed = new Set(proof.matchedGateways.map(gatewayOrigin).filter(Boolean));
  const gateways = new Map<string, string>();
  for (const result of proof.results) {
    const origin = gatewayOrigin(result.gateway);
    if (
      origin === null ||
      !claimed.has(origin) ||
      !result.ok ||
      result.status !== 200 ||
      result.bytes !== artifact.size ||
      result.sha256 !== artifact.sha256 ||
      result.error !== null
    )
      continue;
    if (result.responseUrl !== undefined) {
      try {
        const response = new URL(result.responseUrl);
        if (
          response.origin !== origin ||
          response.pathname !== `/ipfs/${artifact.cid}` ||
          response.username !== "" ||
          response.password !== "" ||
          (response.search !== "" &&
            !(artifact.codec === "directory" && response.search === "?format=raw")) ||
          response.hash !== ""
        )
          continue;
      } catch {
        continue;
      }
    }
    // Different ports or spellings of the same hostname are not independent gateways.
    gateways.set(new URL(origin).hostname, origin);
  }
  if (gateways.size < proof.minimumIndependentGateways) return null;
  return {
    name: artifact.name,
    cid: artifact.cid,
    verified: true,
    matchedGateways: [...gateways.values()],
    minimumIndependentGateways: proof.minimumIndependentGateways,
    results: proof.results,
  };
}

function sameArtifact(left: ManifestArtifact, right: ManifestArtifact): boolean {
  return (
    left.name === right.name &&
    left.cid === right.cid &&
    left.size === right.size &&
    left.codec === right.codec &&
    left.sha256 === right.sha256
  );
}

/** Only bundle-local receipt basenames are allowed; never follow arbitrary paths. */
function receiptName(path: string): string | null {
  return /^artifacts\/[A-Za-z0-9._-]+\.json$/.test(path) ? path.slice("artifacts/".length) : null;
}

/** Read finalized protocol receipts; this does not promote source-semantic readiness. */
async function readFinalizedEvidence(
  dir: string,
  identity: RunIdentity,
  manifest: z.infer<typeof manifestSchema>,
  manifestBytes: Buffer,
  sha256: string,
  car: ManifestArtifact,
) {
  const [rawReport, rawLedger] = await Promise.all([
    readJson<unknown>(resolve(dir, `verification-${identity.runId}.json`)),
    readJson<unknown>(resolve(dir, "publication-attempts.json")),
  ]);
  const reportResult = normalReportSchema.safeParse(rawReport);
  // Older, differently shaped attempts cannot invalidate an otherwise matching attempt.
  const ledgerResult = z
    .object({
      schemaVersion: z.literal("elephant.publication-attempt-ledger.v1"),
      attempts: z.record(z.unknown()),
    })
    .safeParse(rawLedger);
  if (!reportResult.success || !ledgerResult.success) return null;
  const report = reportResult.data;
  const total = manifest.artifacts.length + 1;
  if (
    report.runId !== identity.runId ||
    report.rootCid !== identity.rootCid ||
    report.manifestDigest !== sha256 ||
    report.verification.checkedArtifacts !== total ||
    report.verification.verifiedArtifacts !== total ||
    report.verification.artifacts.length !== total ||
    new Set(report.verification.artifacts.map((entry) => entry.name)).size !== total
  )
    return null;
  const manifestArtifact: ManifestArtifact = {
    name: "manifest.json",
    cid: report.manifestCid,
    size: manifestBytes.length,
    codec: "file",
    sha256,
  };
  const verifications: ArtifactVerification[] = [];
  for (const artifact of [manifestArtifact, ...manifest.artifacts]) {
    const proof = report.verification.artifacts.find((entry) => entry.name === artifact.name);
    const verified = proof
      ? verifiedArtifact(artifact, {
          ...proof,
          minimumIndependentGateways: Math.max(
            proof.minimumIndependentGateways,
            report.verification.minimumIndependentGateways,
          ),
        })
      : null;
    if (!verified) return null;
    verifications.push(verified);
  }
  for (const rawAttempt of Object.values(ledgerResult.data.attempts)) {
    const attemptResult = finalizedAttemptSchema.safeParse(rawAttempt);
    if (!attemptResult.success) continue;
    const attempt = attemptResult.data;
    const target = attempt.target;
    if (
      attempt.state !== "FINALIZED" ||
      target.executionScope === "replication-only" ||
      target.runId !== identity.runId ||
      target.rootCid !== identity.rootCid ||
      target.manifestDigest !== sha256 ||
      target.primaryCars.root.cid !== identity.rootCid ||
      target.primaryCars.manifest.cid !== report.manifestCid ||
      target.primaryCars.archive.cid !== car.cid ||
      attempt.transitions.length !== FINALIZED_STAGES.length ||
      attempt.transitions.some(
        (transition, index) =>
          transition.sequence !== index + 1 || transition.stage !== FINALIZED_STAGES[index],
      )
    )
      continue;
    const terminal = z
      .object({ rootCid: z.string() })
      .safeParse(attempt.transitions.at(-1)?.receipt);
    const ledgerVerification = normalVerificationSchema.safeParse(attempt.transitions[7]?.receipt);
    const retention = secondaryRetentionSchema.safeParse(attempt.transitions[6]?.receipt);
    if (
      !terminal.success ||
      terminal.data.rootCid !== identity.rootCid ||
      !ledgerVerification.success ||
      JSON.stringify(ledgerVerification.data) !== JSON.stringify(report.verification) ||
      !retention.success
    )
      continue;
    const copies = retention.data;
    let copiesMatch = true;
    for (const kind of ["root", "manifest", "archive"] as const) {
      const copy = copies[kind];
      if (
        copy.cid !== target.primaryCars[kind].cid ||
        copy.name !== target.secondaryPin[`${kind}PinName`] ||
        copy.registration.cid !== copy.cid ||
        copy.registration.fileName !== copy.name ||
        copy.metadata.cid !== copy.cid ||
        copy.registration.fileSizeInBytes !== copy.metadata.fileSizeInBytes
      )
        copiesMatch = false;
    }
    const roots = copies.archive.publicGateway?.car?.roots ?? [];
    const expectedRoots = manifest.directoryCars.map((entry) => entry.directoryCid);
    const coveredRoots = copies.root.retentionEvidence?.expectedRoots ?? [];
    if (
      !copiesMatch ||
      roots.length !== expectedRoots.length ||
      new Set(roots).size !== roots.length ||
      expectedRoots.some((root) => !roots.includes(root)) ||
      coveredRoots.length !== roots.length ||
      coveredRoots.some((root, index) => root !== roots[index]) ||
      copies.root.retentionEvidence?.archiveCid !== car.cid ||
      !roots.includes(identity.rootCid!) ||
      copies.manifest.publicGateway?.cid !== report.manifestCid ||
      copies.manifest.publicGateway.bytes !== manifestBytes.length ||
      copies.manifest.publicGateway.sha256 !== sha256 ||
      copies.archive.publicGateway?.cid !== car.cid ||
      copies.archive.publicGateway.bytes !== car.size ||
      copies.archive.publicGateway.sha256 !== car.sha256
    )
      continue;
    return {
      publicationEvidence: {
        runId: identity.runId!,
        rootCid: identity.rootCid!,
        manifestCid: report.manifestCid,
        manifestSha256: sha256,
        manifestBytes: manifestBytes.length,
        carCid: car.cid,
        carBytes: car.size,
        carSha256: car.sha256,
        artifactCount: manifest.artifacts.length,
        verifiedGateways: [...new Set(verifications.flatMap((entry) => entry.matchedGateways))],
        recordedAt: attempt.transitions.at(-1)!.at,
        scope: "finalized-publication-receipt" as const,
        retentionVerified: true as const,
        publicationPromoted: true as const,
      },
      verification: { runId: identity.runId!, rootCid: identity.rootCid!, verifications },
    };
  }
  return null;
}

/**
 * Exact-run standalone proofs are useful even when the finalized latest pointer
 * is deliberately held. They never supply IPNS, retention or promotion claims.
 */
async function readPublicationEvidence(
  config: ServerConfig,
  identity: RunIdentity,
): Promise<{
  publicationEvidence: RunPublicationEvidence;
  verification: VerificationReport;
} | null> {
  if (
    config.localEvidencePreview ||
    identity.runId === null ||
    identity.rootCid === null ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(identity.runId)
  )
    return null;
  const dir = artifactsDir(config);
  const manifestName = `manifest-${identity.runId}.json`;
  let bytes: Buffer;
  let names: string[];
  try {
    [bytes, names] = await Promise.all([readFile(resolve(dir, manifestName)), readdir(dir)]);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const manifest = parsed.data;
  if (
    manifest.runId !== identity.runId ||
    manifest.root.cid !== identity.rootCid ||
    new Set(manifest.artifacts.map((artifact) => artifact.name)).size !==
      manifest.artifacts.length ||
    !manifest.artifacts.some(
      (artifact) => artifact.name === "/" && artifact.cid === identity.rootCid,
    )
  )
    return null;
  const car = manifest.artifacts.find((artifact) => artifact.name === "snapshot.car");
  if (
    !car ||
    manifest.root.car !== `ipfs://${car.cid}` ||
    !manifest.directoryCars.some(
      (entry) => entry.directoryCid === identity.rootCid && entry.carCid === car.cid,
    )
  )
    return null;
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const finalized = await readFinalizedEvidence(dir, identity, manifest, bytes, sha256, car);
  if (finalized) return finalized;
  const inventories = names
    .filter((name) => /^submission-gateway-inventory-[A-Za-z0-9._-]+\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of inventories) {
    const candidate = inventorySchema.safeParse(await readJson<unknown>(resolve(dir, name)));
    if (!candidate.success) continue;
    const inventory = candidate.data;
    if (
      inventory.runId !== identity.runId ||
      inventory.manifest !== `artifacts/${manifestName}` ||
      inventory.manifestSha256 !== sha256 ||
      inventory.listedObjects !== manifest.artifacts.length ||
      inventory.artifacts.length !== manifest.artifacts.length ||
      new Set(inventory.artifacts.map((artifact) => artifact.name)).size !==
        inventory.artifacts.length
    )
      continue;
    const sourceNames = inventory.sourceReceipts.map(receiptName);
    if (sourceNames.some((receipt) => receipt === null)) continue;
    const receipts = new Map<string, unknown>(
      await Promise.all(
        sourceNames.map(
          async (receipt) => [receipt!, await readJson<unknown>(resolve(dir, receipt!))] as const,
        ),
      ),
    );
    const manifestArtifact: ManifestArtifact = {
      name: manifestName,
      cid: inventory.manifestSelfProof.cid,
      size: bytes.length,
      codec: "file",
      sha256,
    };
    const manifestProof = verifiedArtifact(manifestArtifact, inventory.manifestSelfProof);
    if (!manifestProof) continue;
    const readbacks = [...receipts.values()].map((receipt) => readbackSchema.safeParse(receipt));
    const hasManifestReceipt = readbacks.some(
      (receipt) =>
        receipt.success &&
        receipt.data.runId === identity.runId &&
        receipt.data.listedArtifacts.runId === identity.runId &&
        receipt.data.manifestBytes === bytes.length &&
        receipt.data.manifestSha256 === sha256 &&
        verifiedArtifact(manifestArtifact, receipt.data.manifestObject) !== null,
    );
    if (!hasManifestReceipt) continue;
    const verifications: ArtifactVerification[] = [manifestProof];
    for (const artifact of manifest.artifacts) {
      const entry = inventory.artifacts.find((item) => item.name === artifact.name);
      if (!entry || !sameArtifact(artifact, entry)) break;
      const receipt = receipts.get(receiptName(entry.receipt) ?? "");
      const readback = readbackSchema.safeParse(receipt);
      const archive = archiveReceiptSchema.safeParse(receipt);
      let proof: GatewayProof | undefined;
      if (
        readback.success &&
        readback.data.runId === identity.runId &&
        readback.data.listedArtifacts.runId === identity.runId &&
        readback.data.manifestSha256 === sha256
      ) {
        proof = readback.data.listedArtifacts.artifacts.find((item) => item.name === artifact.name);
      } else if (
        archive.success &&
        archive.data.runId === identity.runId &&
        sameArtifact(artifact, archive.data.artifact)
      ) {
        proof = archive.data.verification;
      }
      const verified = proof ? verifiedArtifact(artifact, proof) : null;
      if (
        !verified ||
        entry.matchedGateways.some((gateway) => !verified.matchedGateways.includes(gateway))
      )
        break;
      verifications.push(verified);
    }
    if (verifications.length !== manifest.artifacts.length + 1) continue;
    return {
      publicationEvidence: {
        runId: identity.runId,
        rootCid: identity.rootCid,
        manifestCid: manifestArtifact.cid,
        manifestSha256: sha256,
        manifestBytes: bytes.length,
        carCid: car.cid,
        carBytes: car.size,
        carSha256: car.sha256,
        artifactCount: manifest.artifacts.length,
        verifiedGateways: [...new Set(verifications.flatMap((entry) => entry.matchedGateways))],
        recordedAt: inventory.assembledAt,
        scope: "standalone-public-gateway-observations",
        retentionVerified: false,
        publicationPromoted: false,
      },
      verification: { runId: identity.runId, rootCid: identity.rootCid, verifications },
    };
  }
  return null;
}

/** Never attach a bundled publication or coverage from different served bytes. */
export async function readServedMetadata(config: ServerConfig, identity: RunIdentity) {
  const [coverage, latest, verification, publication] = await Promise.all([
    readCoverage(config),
    readLatest(config),
    readVerification(config, identity.runId),
    readPublicationEvidence(config, identity),
  ]);
  const hasPublicRoot = identity.rootCid !== null;
  return {
    coverage: identity.runId !== null && coverage?.runId === identity.runId ? coverage : null,
    latest:
      hasPublicRoot && latest?.runId === identity.runId && latest.rootCid === identity.rootCid
        ? latest
        : null,
    publicationEvidence: publication?.publicationEvidence ?? null,
    verification:
      publication?.verification ??
      (hasPublicRoot &&
      verification?.runId === identity.runId &&
      verification.rootCid === identity.rootCid
        ? verification
        : null),
  };
}
