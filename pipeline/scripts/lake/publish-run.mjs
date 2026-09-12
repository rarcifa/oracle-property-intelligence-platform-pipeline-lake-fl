#!/usr/bin/env node
/**
 * Publish one Lake County run to public IPFS through Filebase, then prove it
 * is retrievable.
 *
 * The kit's publisher uploads plain S3 objects and accepts whatever CID
 * Filebase assigns, which is a CIDv0. This assignment requires CIDv1 base32,
 * a per-run artifact manifest with sizes and digests, a CAR for every
 * directory root, immutable prior CIDs, and retrieval proven from at least
 * two independent public gateways. None of that is covered by any kit skill,
 * so this script extends `county-open-data-publish`'s conventions using the
 * core modules added alongside it: `core/cid.mjs`, `core/car.mjs`,
 * `core/artifact-manifest.mjs`, `core/gateway-verify.mjs` and
 * `core/run-history.mjs`.
 *
 * The DAG is built and hashed locally first, so the CID is known before
 * anything is uploaded. The CAR is then imported with the
 * `x-amz-meta-import: car` header, which pins exactly the DAG that was
 * computed rather than letting the vendor re-encode it.
 *
 * Usage:
 *   node scripts/lake/publish-run.mjs --run-id <id> [--mode full|incremental]
 *     --candidate-commit <git-sha> --provenance-digest <sha256> [--dry-run]
 *     --expected-ipns-predecessor-cid <cid> --expected-ipns-predecessor-sequence <integer>
 *     [--approve <signed-authorization.json>]
 *     [--approval-public-key <ed25519-public-key.pem>] [--env-file <path>]
 *
 * @module scripts/lake/publish-run
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  buildUnixfsDirectory,
  computeRawCid,
  computeUnixfsFileCid,
  sha256Hex,
} from "../../src/core/cid.mjs";
import { writeCarFile } from "../../src/core/car.mjs";
import { buildArtifactManifest, writeArtifactManifest } from "../../src/core/artifact-manifest.mjs";
import {
  DEFAULT_GATEWAYS,
  verifyArtifactAcrossGateways,
  verifyManifestAcrossGateways,
} from "../../src/core/gateway-verify.mjs";
import { assertPermitTableGate, assertQueryTableGate } from "../../src/counties/lake/adapter.mjs";
import { appendRun, computeTableDeltas } from "../../src/core/run-history.mjs";
import {
  PINATA_SECONDARY_PIN_API_BASE,
  PINATA_SECONDARY_PIN_API_ORIGIN,
  PINATA_SECONDARY_PIN_API_PATH,
  REQUIRED_PUBLISH_ACTIONS,
  advancePublicationAttempt,
  assertPublicationAuthorizationActive,
  authorizePublicationAttempt,
  beginPublicationAttempt,
  consumePublicationAuthorization,
  nextPublicationRecoveryAction,
  publicationAttemptId,
  readPublicationLedger,
  recordVerifiedIpnsReadback,
  sha256Digest,
  validatePublicationTarget,
} from "../../src/core/publish-gate.mjs";
import {
  ensureSecondaryPin,
  validateSecondaryPinServiceEndpoint,
} from "../../src/core/secondary-pin.mjs";
import {
  loadEnvFile,
  fillDerivedFilebaseToken,
  updateExistingFilebaseName,
  FILEBASE_NAMES_API,
} from "../../src/core/filebase.mjs";
import {
  LAKE_BUCKET,
  LAKE_IPNS_LABEL,
  LAKE_IPNS_NETWORK_KEY,
} from "../../src/counties/lake/enrichment-profile.mjs";
import { currentRepositoryCommit, verifyPublicationProvenance } from "./publication-provenance.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..");
const PUBLISH_ROOT = path.join(RUNTIME_ROOT, "data", "artifacts", "publish", "lake");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
const FILEBASE_ENDPOINT = "https://s3.filebase.com";
const PUBLICATION_LEDGER_PATH = path.join(ARTIFACTS_DIR, "publication-attempts.json");
/** The county this publisher releases. Also the publish gate's key. */
const COUNTY = "lake";

/**
 * Credentials are capabilities, not authority. Network publication is
 * reachable only when this invocation supplies both exact signed artifacts
 * and is not explicitly capped as a dry run.
 *
 * @param {{ dryRun: boolean, approvalPath: string | null, approvalPublicKeyPath: string | null }} intent
 */
export function mayAttemptLivePublication(intent) {
  return Boolean(!intent.dryRun && intent.approvalPath && intent.approvalPublicKeyPath);
}

/**
 * Build the only secondary destination an approval may authorize.
 *
 * @param {string} runId - Immutable publication run identity.
 * @returns {{provider: "pinata", apiBase: string, apiOrigin: string, apiPath: string, rootPinName: string, manifestPinName: string}}
 */
export function pinataSecondaryPinTarget(runId) {
  return {
    provider: "pinata",
    apiBase: PINATA_SECONDARY_PIN_API_BASE,
    apiOrigin: PINATA_SECONDARY_PIN_API_ORIGIN,
    apiPath: PINATA_SECONDARY_PIN_API_PATH,
    rootPinName: `${LAKE_IPNS_LABEL}/${runId}/root`,
    manifestPinName: `${LAKE_IPNS_LABEL}/${runId}/manifest`,
  };
}

/**
 * Refuse endpoint normalization. The runtime string must be byte-for-byte the
 * Pinata API base in the signed target before a token, env file, or client is
 * touched.
 *
 * @param {unknown} target - Exact publication target.
 * @param {unknown} endpoint - Raw runtime endpoint value.
 * @returns {string} Exact approved Pinata API base.
 */
export function assertSecondaryPinRuntimeTarget(target, endpoint) {
  const validated = validatePublicationTarget(target);
  if (endpoint !== validated.secondaryPin.apiBase) {
    throw new Error(
      `Secondary pin runtime endpoint must exactly equal signed ${validated.secondaryPin.apiBase}`,
    );
  }
  const parsed = new URL(endpoint);
  if (
    parsed.origin !== validated.secondaryPin.apiOrigin ||
    `${parsed.pathname.replace(/\/$/, "")}/pins` !== validated.secondaryPin.apiPath ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Secondary pin runtime endpoint does not match the signed Pinata origin/path");
  }
  return endpoint;
}

/**
 * Load capabilities only after the public endpoint has matched the signed
 * target. The optional loader injection proves bad targets never read a file.
 *
 * @param {object} options - Capability-loading options.
 * @param {unknown} options.target - Exact publication target.
 * @param {unknown} options.endpoint - Raw runtime secondary-pin endpoint.
 * @param {string | null} options.envFile - Optional external capability file.
 * @param {NodeJS.ProcessEnv} [options.environment] - Mutable environment map.
 * @param {typeof loadEnvFile} [options.loadEnvironmentFile] - Injectable env-file loader.
 * @returns {Promise<{secondaryPinEndpoint: string, secondaryPinToken: string, filebaseApiToken: string | undefined, filebaseCredentials: {accessKeyId: string, secretAccessKey: string}}>} Validated capabilities.
 */
export async function loadLivePublicationCapabilities({
  target,
  endpoint,
  envFile,
  environment = process.env,
  loadEnvironmentFile = loadEnvFile,
}) {
  const exactEndpoint = assertSecondaryPinRuntimeTarget(target, endpoint);
  if (envFile) await loadEnvironmentFile(envFile, environment);
  assertSecondaryPinRuntimeTarget(target, environment.SECONDARY_PIN_SERVICE_URL);
  fillDerivedFilebaseToken(environment);
  if (!environment.S3_ACCESS_KEY_ID || !environment.S3_SECRET_ACCESS_KEY) {
    throw new Error("Filebase credentials are required for a live publish");
  }
  if (!environment.SECONDARY_PIN_SERVICE_TOKEN) {
    throw new Error("A scoped Pinata JWT is required before the primary upload");
  }
  return {
    secondaryPinEndpoint: exactEndpoint,
    secondaryPinToken: environment.SECONDARY_PIN_SERVICE_TOKEN,
    filebaseApiToken: environment.FILEBASE_API_TOKEN,
    filebaseCredentials: {
      accessKeyId: environment.S3_ACCESS_KEY_ID,
      secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
    },
  };
}

/**
 * Bind a mutation to the predecessor recorded in immutable local history.
 * A target CID is accepted only at the IPNS stage, where it means the provider
 * applied the update before the process could persist its receipt.
 */
export function assertPublicationPredecessor(previousRun, readback, target, attemptState) {
  if (readback === null) throw new Error("The existing IPNS pointer could not be read back");
  if (previousRun?.rootCid !== target.ipnsPredecessor.cid) {
    throw new Error("The signed IPNS predecessor does not match immutable local history");
  }
  if (readback.networkKey !== target.ipnsNetworkKey) {
    throw new Error("The existing IPNS network key does not match the exact publication target");
  }
  if (
    readback.cid === target.rootCid &&
    readback.sequence === target.ipnsPredecessor.sequence + 1 &&
    attemptState === "HISTORY_RECORDED"
  ) {
    return "target-already-applied";
  }
  if (
    readback.cid === target.ipnsPredecessor.cid &&
    readback.sequence === target.ipnsPredecessor.sequence
  ) {
    return "recorded-predecessor";
  }
  throw new Error(
    `The live IPNS pointer ${readback.cid}@${readback.sequence} is not the signed predecessor ${target.ipnsPredecessor.cid}@${target.ipnsPredecessor.sequence}; restore the durable publication history before retrying`,
  );
}

/** @param {string} candidate */
function assertExternalApprovalPath(candidate) {
  const resolved = path.resolve(candidate);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`)) {
    throw new Error("signed publication approval must stay outside the repository");
  }
  return resolved;
}

/**
 * @param {string} message - Event name.
 * @param {Record<string, unknown>} [fields] - Extra fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), event: message, ...fields })}\n`,
  );
}

/**
 * @param {readonly string[]} argv - CLI arguments.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

/**
 * Walk a directory, returning every file path relative to it, sorted.
 *
 * @param {string} root - Directory to walk.
 * @param {string} [prefix] - Internal recursion prefix.
 * @returns {Promise<string[]>} Relative file paths.
 */
export async function listFiles(root, prefix = "") {
  /** @type {string[]} */
  const files = [];
  for (const entry of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

/**
 * Manifest entry for one directory in the snapshot.
 *
 * A directory has no content of its own beyond the dag-pb node that lists its
 * children, so that node is what the entry describes: its byte length and its
 * digest. The digest used to be `sha256(cid_string)` — a hash of the identifier
 * rather than of anything the identifier addresses, which proved nothing and
 * could never disagree with the CID it was derived from. Hashing the node bytes
 * makes the entry checkable the same way a file entry is: fetch the block
 * (`?format=raw`) and compare.
 *
 * @param {string} name - Logical name inside the snapshot.
 * @param {{ cid: string, bytes: Uint8Array }} node - Built directory node.
 * @returns {{ cid: string, name: string, size: number, codec: "directory", sha256: string }} Manifest entry.
 */
export function directoryEntry(name, node) {
  return {
    cid: node.cid,
    name,
    size: node.bytes.length,
    codec: "directory",
    sha256: `sha256:${sha256Hex(node.bytes)}`,
  };
}

/**
 * Hash every file in the run directory and assemble the UnixFS DAG, so the
 * root CID is known locally before any upload happens.
 *
 * @param {string} runDir - Run directory.
 * @returns {Promise<{ rootCid: string, rootSize: number, blocks: any[], entries: any[] }>} DAG and per-file facts.
 */
export async function buildRunDag(runDir) {
  const relativePaths = await listFiles(runDir);
  /** @type {Map<string, { name: string, cid: string, size: number }[]>} */
  const directories = new Map([["", []]]);
  /** @type {any[]} */
  const allBlocks = [];
  /** @type {any[]} */
  const entries = [];

  for (const relative of relativePaths) {
    const bytes = await readFile(path.join(runDir, relative));
    const file = computeUnixfsFileCid(bytes);
    allBlocks.push(...file.blocks);
    const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    const base = relative.slice(relative.lastIndexOf("/") + 1);
    if (!directories.has(parent)) directories.set(parent, []);
    directories.get(parent).push({ name: base, cid: file.cid, size: file.size });
    entries.push({
      cid: file.cid,
      name: relative,
      size: bytes.length,
      codec: "file",
      sha256: `sha256:${sha256Hex(bytes)}`,
    });
    log("artifact_hashed", { name: relative, cid: file.cid, bytes: bytes.length });
  }

  // Fold the deepest directories first so a parent links a finished child.
  const depth = (value) => (value === "" ? 0 : value.split("/").length);
  const nested = [...directories.keys()]
    .filter((key) => key !== "")
    .sort((a, b) => depth(b) - depth(a));
  for (const dirPath of nested) {
    const built = buildUnixfsDirectory(directories.get(dirPath));
    allBlocks.push(...built.blocks);
    const parent = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : "";
    const base = dirPath.slice(dirPath.lastIndexOf("/") + 1);
    if (!directories.has(parent)) directories.set(parent, []);
    directories.get(parent).push({ name: base, cid: built.cid, size: built.size });
    entries.push(directoryEntry(`${dirPath}/`, built));
  }

  const root = buildUnixfsDirectory(directories.get(""));
  allBlocks.push(...root.blocks);
  entries.push(directoryEntry("/", root));

  /** @type {Map<string, any>} */
  const unique = new Map();
  for (const block of allBlocks) unique.set(block.cid.toString(), block);
  return { rootCid: root.cid, rootSize: root.size, blocks: [...unique.values()], entries };
}

/**
 * Read an S3 streaming body without trusting its optional declared length.
 *
 * @param {unknown} body - AWS SDK GetObject Body.
 * @returns {Promise<Buffer>} Exact object bytes.
 */
async function readS3Body(body) {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return Buffer.from(await body.transformToByteArray());
  }
  if (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === "function"
  ) {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error("Immutable CAR GET returned no readable body");
}

const immutableCarGetSchema = z
  .object({
    Body: z.unknown(),
    ContentLength: z.number().int().nonnegative().optional(),
    Metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

function isPreconditionFailure(error) {
  return (
    error?.$metadata?.httpStatusCode === 412 ||
    error?.name === "PreconditionFailed" ||
    error?.Code === "PreconditionFailed"
  );
}

/**
 * Create one non-overwritable CAR and reconcile the exact stored bytes.
 *
 * A retry still sends the conditional request: S3 rejects the mutation with
 * 412, then GET proves whether the already-created object is byte-identical.
 * A colliding key can therefore never silently replace the first CAR.
 *
 * @param {object} options - Options.
 * @param {S3Client} options.client - Configured S3 client.
 * @param {string} options.bucket - Authorization-bound destination bucket.
 * @param {string} options.key - Authorization-bound immutable object key.
 * @param {Buffer} options.body - Exact CAR bytes.
 * @param {string} [options.expectedCid] - Locally computed CAR root CID.
 * @returns {Promise<{action: "created" | "reconciled-existing", key: string, bytes: number, sha256: string, reportedCid: string | null}>}
 */
export async function uploadImmutableCar({ client, bucket, key, body, expectedCid }) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new Error("Immutable CAR upload requires non-empty Buffer bytes");
  }
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "application/vnd.ipld.car",
    Metadata: { import: "car" },
    IfNoneMatch: "*",
  });
  /** @type {string | null} */
  let reportedCid = null;
  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const header = result.response?.headers?.["x-amz-meta-cid"];
      if (typeof header === "string") reportedCid = header.trim();
      return result;
    },
    { step: "deserialize", name: `captureCid-${key.replace(/[^a-z0-9]/gi, "-")}`, priority: "low" },
  );
  let action = "created";
  try {
    await client.send(command);
  } catch (error) {
    if (!isPreconditionFailure(error)) throw error;
    action = "reconciled-existing";
  }

  const readbackCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
  let readbackCid = null;
  readbackCommand.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const header = result.response?.headers?.["x-amz-meta-cid"];
      if (typeof header === "string") readbackCid = header.trim();
      return result;
    },
    {
      step: "deserialize",
      name: `captureReadbackCid-${key.replace(/[^a-z0-9]/gi, "-")}`,
      priority: "low",
    },
  );
  const readback = immutableCarGetSchema.parse(await client.send(readbackCommand));
  const readbackBody = await readS3Body(readback.Body);
  const expectedSha256 = sha256Digest(body);
  const readbackSha256 = sha256Digest(readbackBody);
  if (
    (readback.ContentLength !== undefined && readback.ContentLength !== readbackBody.length) ||
    readbackBody.length !== body.length ||
    readbackSha256 !== expectedSha256 ||
    !readbackBody.equals(body)
  ) {
    throw new Error(`Immutable CAR ${key} already exists with different bytes`);
  }
  const exactReportedCid = reportedCid ?? readbackCid ?? readback.Metadata?.cid?.trim() ?? null;
  if (expectedCid !== undefined && exactReportedCid !== null && exactReportedCid !== expectedCid) {
    throw new Error(`Filebase reported CAR root ${exactReportedCid}, expected ${expectedCid}`);
  }
  return {
    action,
    key,
    bytes: body.length,
    sha256: expectedSha256,
    reportedCid: exactReportedCid,
  };
}

/**
 * Publish a built run directory.
 *
 * @param {object} options - Options.
 * @param {string} options.runId - Run identifier.
 * @param {string} options.mode - `full` or `incremental`.
 * @param {string} options.candidateWorkflowRunId - GitHub run that built the frozen candidate, or `local`.
 * @param {string} options.candidateCommit - Exact Git commit that built the frozen candidate.
 * @param {boolean} options.dryRun - When true, compute and write locally but upload nothing.
 * @param {string | null} options.approvalPath - External signed exact-target approval.
 * @param {string | null} options.approvalPublicKeyPath - Trusted Ed25519 public key.
 * @param {string | null} options.envFile - Optional external Filebase environment file.
 * @param {string} options.provenanceDigest - Frozen runtime/config/schema provenance.
 * @param {string} options.expectedIpnsPredecessorCid - Reviewed current IPNS CID.
 * @param {number} options.expectedIpnsPredecessorSequence - Reviewed current IPNS sequence.
 * @returns {Promise<Record<string, unknown>>} The run record appended to history.
 */
export async function publishRun({
  runId,
  mode,
  candidateWorkflowRunId,
  candidateCommit,
  dryRun,
  approvalPath,
  approvalPublicKeyPath,
  envFile,
  provenanceDigest,
  expectedIpnsPredecessorCid,
  expectedIpnsPredecessorSequence,
}) {
  if (mode !== "full" && mode !== "incremental") {
    throw new Error("Publication mode must be full or incremental");
  }
  // This is deliberately the first asynchronous boundary. Source/runtime
  // drift is rejected before run artifacts, approvals, credentials, or any
  // network-capable client are touched.
  const publicationProvenance = await verifyPublicationProvenance({
    repoRoot: REPO_ROOT,
    candidateCommit,
    currentCommit: await currentRepositoryCommit(REPO_ROOT),
    expectedDigest: provenanceDigest,
  });
  if (!/^b[a-z2-7]{20,}$/.test(expectedIpnsPredecessorCid)) {
    throw new Error("An exact expected IPNS predecessor CID is required");
  }
  if (
    !Number.isSafeInteger(expectedIpnsPredecessorSequence) ||
    expectedIpnsPredecessorSequence < 0
  ) {
    throw new Error("An exact non-negative expected IPNS predecessor sequence is required");
  }
  const runDir = path.join(PUBLISH_ROOT, "runs", runId);
  const carDir = path.join(PUBLISH_ROOT, "cars");
  await mkdir(carDir, { recursive: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  const started = new Date().toISOString();

  // Before the DAG is hashed, the CAR uploaded, or IPNS moved — a truncated
  // acquisition must fail here, not become an immutable published root.
  const coverage = JSON.parse(await readFile(path.join(runDir, "coverage.json"), "utf8"));
  const historyPath = path.join(ARTIFACTS_DIR, "run-history.json");
  const previousRun = await readPreviousRun(historyPath);
  if (previousRun?.rootCid !== expectedIpnsPredecessorCid) {
    throw new Error(
      `Expected IPNS predecessor ${expectedIpnsPredecessorCid} does not match immutable local history ${previousRun?.rootCid ?? "none"}`,
    );
  }
  assertTablesPlausible(coverageTableRows(coverage), previousRun);

  // The kit's one-row-per-property invariant: no null folio, and exactly as many
  // rows as distinct folios. It was written, exported, and never called — a gate
  // beside the path rather than on it, which is the same defect the approval gate
  // had. A table that silently duplicated or dropped parcels would have published.
  const gateCounts = await assertQueryTableGate(path.join(runDir, "query-table.parquet"));
  log("query_table_gate", gateCounts);
  const permitGateCounts = await assertPermitTableGate(path.join(runDir, "permit-table.parquet"));
  log("permit_table_gate", permitGateCounts);

  const dag = await buildRunDag(runDir);
  log("dag_built", {
    rootCid: dag.rootCid,
    blocks: dag.blocks.length,
    artifacts: dag.entries.length,
  });

  const carPath = path.join(carDir, `${runId}.car`);
  const car = await writeCarFile({ roots: [dag.rootCid], blocks: dag.blocks, outputPath: carPath });
  log("car_written", { path: car.path, bytes: car.bytes, rootCid: car.rootCid });

  // The manifest's own CID must be reproducible for a given run, so its
  // timestamp comes from the run id rather than the clock. A wall-clock value
  // here changes the manifest bytes on every invocation, which changes its CID
  // and orphans the copy already pinned on IPFS.
  const manifest = buildArtifactManifest({
    runId,
    county: "lake",
    generatedAt: runIdToIso(runId),
    rootCid: dag.rootCid,
    // Content-addressed, not a filesystem path. The manifest used to record the
    // CAR as a local `pipeline/data/.../cars/<run>.car`, which a third party working
    // from the manifest alone cannot resolve — and the .car is build output that
    // is deliberately not committed. The CAR's DAG root IS the run root, so this
    // locator is retrievable from any gateway with `?format=car`.
    rootCarPath: `ipfs://${dag.rootCid}?format=car`,
    entries: dag.entries,
  });
  const manifestPath = path.join(runDir, "..", "..", "manifests", `${runId}.json`);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    path.join(path.dirname(manifestPath), `${runId}.publication-provenance.json`),
    `${JSON.stringify(publicationProvenance, null, 2)}\n`,
    "utf8",
  );
  // Where this machine wrote the CAR. It used to ride along in the published
  // manifest as `root.carBuildPath`, which put a local filesystem layout inside
  // an immutable public artifact and resolved for nobody but this machine. It
  // is genuinely useful to the operator re-importing a run, so it is kept — in
  // local run state, beside the CAR, under the gitignored data directory.
  await writeFile(
    path.join(path.dirname(manifestPath), `${runId}.build.json`),
    `${JSON.stringify({ runId, rootCid: dag.rootCid, carBuildPath: path.relative(REPO_ROOT, carPath) }, null, 2)}\n`,
    "utf8",
  );
  const manifestWrite = await writeArtifactManifest(manifest, manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const manifestCid = computeRawCid(manifestBytes);
  const manifestCar = await writeCarFile({
    roots: [manifestCid],
    blocks: [{ cid: manifestCid, bytes: manifestBytes }],
    outputPath: path.join(carDir, `${runId}-manifest.car`),
  });
  const rootCarBody = await readFile(car.path);
  const manifestCarBody = await readFile(manifestCar.path);
  const primaryCars = {
    root: {
      key: `runs/${runId}/root.car`,
      bytes: rootCarBody.length,
      sha256: sha256Digest(rootCarBody),
      cid: car.rootCid,
    },
    manifest: {
      key: `runs/${runId}/manifest.car`,
      bytes: manifestCarBody.length,
      sha256: sha256Digest(manifestCarBody),
      cid: manifestCid,
    },
  };
  log("manifest_written", { manifestCid, bytes: manifestWrite.bytes });

  const target = {
    county: COUNTY,
    runId,
    mode,
    candidateWorkflowRunId,
    candidateCommit,
    rootCid: dag.rootCid,
    manifestDigest: manifestWrite.sha256,
    provenanceDigest,
    bucket: LAKE_BUCKET,
    primaryCars,
    secondaryPin: pinataSecondaryPinTarget(runId),
    ipnsLabel: LAKE_IPNS_LABEL,
    ipnsNetworkKey: LAKE_IPNS_NETWORK_KEY,
    ipnsPredecessor: {
      cid: expectedIpnsPredecessorCid,
      sequence: expectedIpnsPredecessorSequence,
    },
    actions: [...REQUIRED_PUBLISH_ACTIONS],
  };
  const attemptId = publicationAttemptId(target);
  await beginPublicationAttempt(PUBLICATION_LEDGER_PATH, target);
  await advancePublicationAttempt(PUBLICATION_LEDGER_PATH, attemptId, "FROZEN", {
    rootCid: dag.rootCid,
    runDirectory: path.relative(REPO_ROOT, runDir),
  });
  await advancePublicationAttempt(PUBLICATION_LEDGER_PATH, attemptId, "BUILT", {
    rootCar: { cid: car.rootCid, bytes: car.bytes },
    manifest: { cid: manifestCid, digest: manifestWrite.sha256, bytes: manifestWrite.bytes },
    primaryCars,
  });
  const approvalRequestPath = path.join(
    path.dirname(manifestPath),
    `${runId}.publication-request.json`,
  );
  await writeFile(
    approvalRequestPath,
    `${JSON.stringify({ schemaVersion: "elephant.publication-request.v1", attemptId, target }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  // An explicit dry-run is an unbreakable ceiling. Credentials by themselves
  // have no authority, and a missing signature only prepares a review target.
  if (!mayAttemptLivePublication({ dryRun, approvalPath, approvalPublicKeyPath })) {
    const attempt = (await readPublicationLedger(PUBLICATION_LEDGER_PATH)).attempts[attemptId];
    log("publication_prepared_local", {
      attemptId,
      approvalRequestPath,
      nextAction: nextPublicationRecoveryAction(attempt),
      reason: dryRun ? "explicit dry-run" : "exact signed authorization not supplied",
    });
    return {
      runId,
      mode,
      candidateWorkflowRunId,
      candidateCommit,
      rootCid: dag.rootCid,
      manifestCid,
      carCid: car.rootCid,
      dryRun: true,
      publicationState: "PREPARED_LOCAL",
      attemptId,
      approvalRequestPath,
    };
  }

  // This comparison deliberately precedes approval/key/env-file reads and all
  // network clients. A URL that merely normalizes to Pinata is not equivalent
  // to the exact destination the human signed.
  const secondaryPinEndpoint = assertSecondaryPinRuntimeTarget(
    target,
    process.env.SECONDARY_PIN_SERVICE_URL,
  );
  const approval = JSON.parse(await readFile(assertExternalApprovalPath(approvalPath), "utf8"));
  const publicKey = await readFile(approvalPublicKeyPath);
  let attempt = await authorizePublicationAttempt(
    PUBLICATION_LEDGER_PATH,
    attemptId,
    approval,
    publicKey,
  );
  const gatedDryRun = false;
  let predecessorState = null;
  /** @type {Awaited<ReturnType<typeof loadLivePublicationCapabilities>> | null} */
  let capabilities = null;

  /** @type {Record<string, unknown>} */
  const publishResult = {
    dryRun: gatedDryRun,
    rootCid: dag.rootCid,
    manifestCid,
    carCid: car.rootCid,
  };

  if (!gatedDryRun) {
    capabilities = await loadLivePublicationCapabilities({
      target,
      endpoint: secondaryPinEndpoint,
      envFile,
    });
    validateSecondaryPinServiceEndpoint(capabilities.secondaryPinEndpoint);
    if (
      [
        "AUTHORIZED",
        "ROOT_UPLOAD_RECORDED",
        "MANIFEST_UPLOAD_RECORDED",
        "SECONDARY_PIN_RECORDED",
        "VERIFIED",
        "HISTORY_RECORDED",
      ].includes(attempt.state)
    ) {
      const pointer = await readIpnsPointer(capabilities.filebaseApiToken);
      predecessorState = assertPublicationPredecessor(previousRun, pointer, target, attempt.state);
    }
    const client = new S3Client({
      endpoint: FILEBASE_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: capabilities.filebaseCredentials,
    });
    if (attempt.state === "AUTHORIZED") {
      assertPublicationAuthorizationActive(attempt);
      const rootUpload = await uploadImmutableCar({
        client,
        bucket: target.bucket,
        key: target.primaryCars.root.key,
        body: rootCarBody,
        expectedCid: target.primaryCars.root.cid,
      });
      const rootReported = rootUpload.reportedCid;
      if (rootReported !== null && rootReported !== dag.rootCid) {
        throw new Error(`Filebase reported root ${rootReported}, expected ${dag.rootCid}`);
      }
      log("car_uploaded", {
        key: target.primaryCars.root.key,
        action: rootUpload.action,
        reportedCid: rootReported,
        computedCid: dag.rootCid,
      });
      publishResult.filebaseReportedRootCid = rootReported;
      attempt = await advancePublicationAttempt(
        PUBLICATION_LEDGER_PATH,
        attemptId,
        "ROOT_UPLOAD_RECORDED",
        {
          ...target.primaryCars.root,
          action: rootUpload.action,
          computedCid: dag.rootCid,
          reportedCid: rootReported,
        },
      );
    }
    if (attempt.state === "ROOT_UPLOAD_RECORDED") {
      assertPublicationAuthorizationActive(attempt);
      const manifestUpload = await uploadImmutableCar({
        client,
        bucket: target.bucket,
        key: target.primaryCars.manifest.key,
        body: manifestCarBody,
        expectedCid: target.primaryCars.manifest.cid,
      });
      const manifestReported = manifestUpload.reportedCid;
      if (manifestReported !== null && manifestReported !== manifestCid) {
        throw new Error(`Filebase reported manifest ${manifestReported}, expected ${manifestCid}`);
      }
      log("manifest_car_uploaded", { reportedCid: manifestReported, computedCid: manifestCid });
      publishResult.filebaseReportedManifestCid = manifestReported;
      attempt = await advancePublicationAttempt(
        PUBLICATION_LEDGER_PATH,
        attemptId,
        "MANIFEST_UPLOAD_RECORDED",
        {
          ...target.primaryCars.manifest,
          action: manifestUpload.action,
          computedCid: manifestCid,
          reportedCid: manifestReported,
        },
      );
    }
    if (attempt.state === "MANIFEST_UPLOAD_RECORDED") {
      const pinOptions = {
        endpoint: target.secondaryPin.apiBase,
        token: capabilities.secondaryPinToken,
        beforeCreate: () => assertPublicationAuthorizationActive(attempt),
      };
      const rootPin = await ensureSecondaryPin({
        ...pinOptions,
        cid: dag.rootCid,
        name: target.secondaryPin.rootPinName,
      });
      const manifestPin = await ensureSecondaryPin({
        ...pinOptions,
        cid: manifestCid,
        name: target.secondaryPin.manifestPinName,
      });
      attempt = await advancePublicationAttempt(
        PUBLICATION_LEDGER_PATH,
        attemptId,
        "SECONDARY_PIN_RECORDED",
        { root: rootPin, manifest: manifestPin },
      );
    }
  }

  const evidencePath = path.join(ARTIFACTS_DIR, `verification-${runId}.json`);
  /** @type {any} */
  let verification;
  if (attempt.state === "SECONDARY_PIN_RECORDED") {
    const files = await verifyManifestAcrossGateways({ manifest });
    const manifestEntry = {
      cid: manifestCid,
      name: "manifest.json",
      size: manifestBytes.length,
      sha256: `sha256:${sha256Hex(manifestBytes)}`,
    };
    const manifestVerification = await verifyArtifactAcrossGateways({
      cid: manifestEntry.cid,
      expectedSize: manifestEntry.size,
      expectedSha256: manifestEntry.sha256,
    });
    verification = {
      checkedArtifacts: files.checkedArtifacts + 1,
      verifiedArtifacts: files.verifiedArtifacts + (manifestVerification.verified ? 1 : 0),
      minimumIndependentGateways: 2,
      artifacts: [
        {
          name: manifestEntry.name,
          cid: manifestEntry.cid,
          verified: manifestVerification.verified,
          matchedGateways: manifestVerification.matchedGateways,
          results: manifestVerification.results,
        },
        ...files.artifacts,
      ],
    };
    attempt = await advancePublicationAttempt(
      PUBLICATION_LEDGER_PATH,
      attemptId,
      "VERIFIED",
      verification,
    );
  } else {
    verification = attempt.transitions.find(
      (transition) => transition.stage === "VERIFIED",
    )?.receipt;
  }

  const verifiedGateways = [
    ...new Set(
      verification.artifacts.flatMap((entry) =>
        entry.results.filter((result) => result.ok).map((result) => result.gateway),
      ),
    ),
  ];

  const previousHashes = await readPreviousRowHashes(historyPath, previousRun);
  const currentHashes = await readCurrentRowHashes(path.join(runDir, "query-table.parquet"));
  const deltas = computeTableDeltas(previousHashes, currentHashes);
  const tableAccounting = buildTableAccounting(coverage, deltas, previousRun);

  const runRecord = {
    runId,
    candidateWorkflowRunId,
    candidateCommit,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    mode,
    sources: [
      {
        name: "fl-dor-nal-2026p",
        url: "https://floridarevenue.com/property/dataportal",
        window: "2026 preliminary roll",
        recordCount: coverage.tables.properties.rows,
      },
      {
        name: "fl-gio-parcel-centroids-2025",
        url: "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0",
        window: "2025 release",
        recordCount: coverage.tables.coordinates.rows,
      },
      {
        name: "lake-cdplus-permits",
        url: "https://utility.arcgis.com/usrsvcs/servers/365d9a169bc34110a3db2157c76f6c95/rest/services/Individual/CDPermitParcels/MapServer/0",
        window: mode === "incremental" ? "Permit_LastModDate window" : "full scan",
        recordCount: coverage.tables.permits.bySource.lake_cdplus_permits,
      },
      {
        name: "lake-clermont-etrakit-permits",
        url: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
        window: `permit years ${coverage.tables.contractors.permitYears.join(", ")}`,
        recordCount: coverage.tables.permits.bySource.lake_clermont_etrakit_permits,
      },
    ],
    tables: tableAccounting,
    limitations: coverage.limitations,
    rootCid: dag.rootCid,
    manifestCid,
    carCid: car.rootCid,
    ipnsName: LAKE_IPNS_NETWORK_KEY,
    resolvedCid: dag.rootCid,
    verifiedGateways,
    status: "succeeded",
  };
  if (attempt.state === "VERIFIED") {
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          runId,
          mode,
          candidateWorkflowRunId,
          candidateCommit,
          rootCid: dag.rootCid,
          manifestCid,
          manifestDigest: manifestWrite.sha256,
          verification,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeArtifactManifest(manifest, path.join(ARTIFACTS_DIR, `manifest-${runId}.json`));
    attempt = await advancePublicationAttempt(
      PUBLICATION_LEDGER_PATH,
      attemptId,
      "HISTORY_RECORDED",
      {
        runRecord,
        verificationEvidence: path.relative(REPO_ROOT, evidencePath),
        verificationDigest: sha256Digest(await readFile(evidencePath)),
      },
    );
  }
  const durableRunRecord =
    attempt.transitions.find((transition) => transition.stage === "HISTORY_RECORDED")?.receipt
      ?.runRecord ?? runRecord;
  if (attempt.state === "HISTORY_RECORDED") {
    if (predecessorState === "target-already-applied") {
      attempt = await advancePublicationAttempt(
        PUBLICATION_LEDGER_PATH,
        attemptId,
        "IPNS_REPOINT_RECORDED",
        {
          label: LAKE_IPNS_LABEL,
          networkKey: LAKE_IPNS_NETWORK_KEY,
          cid: dag.rootCid,
          reconciled: true,
        },
      );
    } else {
      assertPublicationAuthorizationActive(attempt);
      const name = await updateExistingFilebaseName(
        capabilities.filebaseApiToken,
        LAKE_IPNS_LABEL,
        LAKE_IPNS_NETWORK_KEY,
        dag.rootCid,
      );
      attempt = await advancePublicationAttempt(
        PUBLICATION_LEDGER_PATH,
        attemptId,
        "IPNS_REPOINT_RECORDED",
        { label: name.label, networkKey: name.network_key, cid: name.cid },
      );
    }
  }
  if (attempt.state === "IPNS_REPOINT_RECORDED") {
    const readback = await readIpnsPointer(capabilities.filebaseApiToken);
    attempt = await recordVerifiedIpnsReadback(PUBLICATION_LEDGER_PATH, attemptId, readback);
  }
  if (attempt.state === "IPNS_VERIFIED") {
    attempt = await consumePublicationAuthorization(PUBLICATION_LEDGER_PATH, attemptId);
  }
  if (attempt.state === "APPROVAL_CONSUMED") {
    // History first, then the row-hash baseline. If this is written before the
    // append, an interrupted run leaves a baseline with no matching history
    // entry, and the retry then diffs the run against itself and reports every
    // row as unchanged when it was in fact the first load.
    const history = JSON.parse(await readFile(historyPath, "utf8"));
    const existing = history.runs?.find((entry) => entry.runId === runId);
    if (existing === undefined) await appendRun(historyPath, durableRunRecord);
    else if (JSON.stringify(existing) !== JSON.stringify(durableRunRecord)) {
      throw new Error(`Run ${runId} exists with different immutable history evidence`);
    }
    await writeFile(
      path.join(ARTIFACTS_DIR, "row-hashes.json"),
      `${JSON.stringify({ runId, hashes: Object.fromEntries(currentHashes) })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(ARTIFACTS_DIR, "latest.json"),
      `${JSON.stringify(
        {
          runId,
          mode,
          candidateWorkflowRunId,
          candidateCommit,
          rootCid: dag.rootCid,
          manifestCid,
          carCid: car.rootCid,
          ipnsName: LAKE_IPNS_NETWORK_KEY,
          resolvedCid: dag.rootCid,
          verifiedGateways,
          propertyCount: coverage.tables.properties.rows,
          publishedAt: durableRunRecord.finishedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    attempt = await advancePublicationAttempt(PUBLICATION_LEDGER_PATH, attemptId, "FINALIZED", {
      runHistory: path.relative(REPO_ROOT, historyPath),
      rootCid: dag.rootCid,
    });
  }
  log("publish_complete", { ...publishResult, attemptId, state: attempt.state, verifiedGateways });
  return durableRunRecord;
}

/**
 * Convert a compact run id such as `20260909T182356Z` into an ISO timestamp.
 *
 * @param {string} runId - Run identifier.
 * @returns {string} ISO-8601 timestamp.
 */
export function runIdToIso(runId) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(runId);
  if (!match) throw new Error(`Run id is not a compact UTC timestamp: ${runId}`);
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

/**
 * Map verification outcomes onto the run-history status vocabulary.
 *
 * @param {boolean} dryRun - Whether this was a dry run.
 * @param {readonly { verified: boolean }[]} verifications - Per-artifact verification results.
 * @returns {"succeeded" | "partial" | "failed"} Run status.
 */
export function runStatus(dryRun, verifications) {
  if (dryRun || verifications.length === 0) return "partial";
  if (verifications.every((entry) => entry.verified)) return "succeeded";
  return verifications.some((entry) => entry.verified) ? "partial" : "failed";
}

/**
 * Read the county's IPNS label back from Filebase and report the CID it
 * currently resolves to.
 *
 * @param {string | undefined} token - Filebase API token.
 * @param {typeof fetch} [fetchImpl] - Injected fetch, for tests.
 * @returns {Promise<{ networkKey: string, cid: string, sequence: number } | null>} Pointer state, or null when absent.
 */
export async function readIpnsPointer(token, fetchImpl = fetch) {
  const response = await fetchImpl(FILEBASE_NAMES_API, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Filebase names listing failed: HTTP ${response.status}`);
  const names = await response.json();
  const entry = Array.isArray(names) ? names.find((name) => name.label === LAKE_IPNS_LABEL) : null;
  if (!entry) return null;
  if (
    typeof entry.network_key !== "string" ||
    typeof entry.cid !== "string" ||
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence < 0
  ) {
    throw new Error("Filebase returned an invalid IPNS predecessor receipt");
  }
  return { networkKey: entry.network_key, cid: entry.cid, sequence: entry.sequence };
}

/**
 * The per-table row counts a coverage snapshot claims, as plain pairs.
 *
 * @param {object} coverage - A run's coverage snapshot.
 * @returns {{name: string, rows: number}[]} Row counts per published table.
 */
export function coverageTableRows(coverage) {
  const rows = [
    { name: "properties", rows: coverage.tables.properties.rows },
    { name: "permits", rows: coverage.tables.permits.rows },
    { name: "coordinates", rows: coverage.tables.coordinates.rows },
  ];
  const business = coverage.tables.businessAccounts;
  if (business) rows.push({ name: "businessAccounts", rows: business.matchedToParcel });
  const contractors = coverage.tables.contractors;
  if (contractors) rows.push({ name: "contractors", rows: contractors.rows });
  return rows;
}

/**
 * Refuse to publish a run in which a table has implausibly collapsed.
 *
 * A windowed permit fetch with no base to merge into produced 281 permits where
 * the previous run had 17,671, and published it. Every gate passed: readiness
 * ran, the DAG hashed, CIDs matched byte for byte, gateways verified. They all
 * check that the bytes are what they claim to be, and none of them can tell a
 * small county from a truncated one.
 *
 * So the shape of the data is checked against the last run that was actually
 * published. A table may grow freely and may shrink a little — parcels are
 * combined, permits are voided — but losing most of a table means the source
 * was not fully acquired, and that is a failure, not a publication.
 *
 * Fail-closed by design, and overridable only deliberately: a genuine large
 * contraction is published by setting ORACLE_ALLOW_TABLE_SHRINK, which records
 * the intent in the run's own environment rather than silently tolerating it.
 *
 * @param {{name: string, rows: number}[]} tables - This run's per-table row counts.
 * @param {object | null} previousRun - The previously recorded run, if any.
 * @param {NodeJS.ProcessEnv} [env] - Environment, for the override.
 * @returns {void}
 * @throws {Error} When a table has lost more than the tolerated fraction.
 */
export function assertTablesPlausible(tables, previousRun, env = process.env) {
  if (!previousRun) return;
  if (env.ORACLE_ALLOW_TABLE_SHRINK === "1") return;
  const previous = new Map((previousRun.tables ?? []).map((table) => [table.name, table.rows]));
  for (const table of tables) {
    const before = previous.get(table.name);
    if (typeof before !== "number" || before === 0) continue;
    if (table.rows >= before * MINIMUM_TABLE_RETENTION) continue;
    throw new Error(
      `Refusing to publish: table '${table.name}' fell from ${before} to ${table.rows} rows ` +
        `(${((table.rows / before) * 100).toFixed(1)}% retained, floor is ` +
        `${(MINIMUM_TABLE_RETENTION * 100).toFixed(0)}%). A table this much smaller means the ` +
        `source was not fully acquired. Set ORACLE_ALLOW_TABLE_SHRINK=1 to publish a genuine contraction.`,
    );
  }
}

/** A published table may shrink, but losing half of it is a failed acquisition. */
export const MINIMUM_TABLE_RETENTION = 0.5;

/**
 * Read the most recently recorded run, for table-level movement.
 *
 * @param {string} historyPath - Run-history path.
 * @returns {Promise<object | null>} The newest recorded run, or null.
 */
export async function readPreviousRun(historyPath) {
  try {
    const parsed = JSON.parse(await readFile(historyPath, "utf8"));
    const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    if (runs.length === 0) return null;
    return runs.reduce((newest, run) => (run.runId > newest.runId ? run : newest));
  } catch {
    return null;
  }
}

/**
 * Account for every table this run publishes, not only the hashed one.
 *
 * `properties` is hashed per row, so it carries true insert/update/unchanged/
 * removed counts. The rest have no per-row snapshot, so they carry their row
 * total and its movement since the previous run, marked `row-count` — reporting
 * four zeroes for them would claim nothing changed at a grain never measured.
 *
 * @param {object} coverage - The run's coverage snapshot.
 * @param {{inserted: number, updated: number, unchanged: number, removed: number}} deltas - Property row deltas.
 * @param {object | null} previousRun - The previously recorded run, if any.
 * @returns {object[]} Table accounting records.
 */
export function buildTableAccounting(coverage, deltas, previousRun) {
  const previousRows = new Map(
    (previousRun?.tables ?? []).map((table) => [table.name, table.rows]),
  );
  const counted = (name, rows) => {
    const before = previousRows.get(name);
    return {
      name,
      rows,
      basis: "row-count",
      ...(typeof before === "number" ? { previousRows: before, rowsDelta: rows - before } : {}),
    };
  };
  const tables = [
    {
      name: "properties",
      rows: coverage.tables.properties.rows,
      basis: "row-hash",
      inserted: deltas.inserted,
      updated: deltas.updated,
      unchanged: deltas.unchanged,
      removed: deltas.removed,
    },
    counted("permits", coverage.tables.permits.rows),
    counted("coordinates", coverage.tables.coordinates.rows),
  ];
  const business = coverage.tables.businessAccounts;
  // Published only since the coverage snapshot carried it; absent on older runs.
  if (business) tables.push(counted("businessAccounts", business.matchedToParcel));
  // Contractors are also part of `coverageTableRows`, so losing a certified
  // Clermont baseline is a publish-time failure rather than a legal zero. The
  // workflow now fails before consolidation when that exact baseline is absent.
  const contractors = coverage.tables.contractors;
  if (contractors) tables.push(counted("contractors", contractors.rows));
  return tables;
}

/**
 * Read the row hashes recorded by the previous run, for delta computation.
 *
 * @param {string} historyPath - Run-history path (its sibling holds the hashes).
 * A clean runner does not have the mutable local hash cache. In that case the
 * immutable Parquet named by the newest durable run record is the baseline.
 * Returning an empty map for a missing cache would silently report every
 * property as inserted, so an unreachable recorded predecessor fails closed.
 *
 * @param {object | null} previousRun - The newest durable run record.
 * @param {{gateways?: readonly string[], readHashes?: typeof readCurrentRowHashes}} [options]
 * @returns {Promise<Map<string, string>>} Parcel id to row hash.
 */
export async function readPreviousRowHashes(historyPath, previousRun = null, options = {}) {
  const localPath = path.join(path.dirname(historyPath), "row-hashes.json");
  try {
    const parsed = JSON.parse(await readFile(localPath, "utf8"));
    if (!parsed || typeof parsed.hashes !== "object" || Array.isArray(parsed.hashes)) {
      throw new Error(`${localPath} does not contain a hashes object`);
    }
    return new Map(Object.entries(parsed.hashes));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (!previousRun) {
    return new Map();
  }

  const rootCid = previousRun.rootCid;
  if (typeof rootCid !== "string" || rootCid.length === 0) {
    throw new Error("The previous run is missing rootCid; cannot recover row-hash baseline");
  }

  const gateways = options.gateways ?? DEFAULT_GATEWAYS;
  const readHashes = options.readHashes ?? readCurrentRowHashes;
  const failures = [];
  for (const gateway of gateways) {
    const url = `${gateway.replace(/\/+$/, "")}/ipfs/${rootCid}/query-table.parquet`;
    try {
      return await readHashes(url);
    } catch (error) {
      failures.push(`${new URL(gateway).host}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(
    `Could not reconstruct row hashes from recorded predecessor ${rootCid}: ${failures.join("; ")}`,
  );
}

/**
 * Hash every published row so the next run can compute record deltas.
 *
 * @param {string} parquetPath - Query-table Parquet.
 * @returns {Promise<Map<string, string>>} Parcel id to row hash.
 */
export async function readCurrentRowHashes(parquetPath) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run(
    "duckdb",
    [
      "-csv",
      "-noheader",
      "-c",
      `SELECT request_identifier || ',' || md5(concat_ws('|', coalesce(CAST(assessed_value AS VARCHAR),''), ` +
        `coalesce(CAST(permit_count AS VARCHAR),''), coalesce(CAST(open_permit_count AS VARCHAR),''), ` +
        `coalesce(CAST(roof_age_years AS VARCHAR),''), coalesce(owner_name,''), coalesce(latest_permit_date,''))) ` +
        `FROM '${parquetPath}';`,
    ],
    { maxBuffer: 1024 * 1024 * 512 },
  );
  /** @type {Map<string, string>} */
  const hashes = new Map();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [parcel, hash] = trimmed.split(",");
    if (parcel && hash) hashes.set(parcel, hash);
  }
  return hashes;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseArgs(process.argv.slice(2));
  const predecessorSequenceFlag = flags["expected-ipns-predecessor-sequence"];
  publishRun({
    runId: String(flags["run-id"] ?? ""),
    mode: String(flags.mode ?? "full"),
    candidateWorkflowRunId: String(flags["candidate-workflow-run-id"] ?? "local"),
    candidateCommit: String(flags["candidate-commit"] ?? "").toLowerCase(),
    dryRun: flags["dry-run"] === true,
    approvalPath: typeof flags.approve === "string" ? flags.approve : null,
    approvalPublicKeyPath:
      typeof flags["approval-public-key"] === "string" ? flags["approval-public-key"] : null,
    envFile: typeof flags["env-file"] === "string" ? flags["env-file"] : null,
    provenanceDigest: String(flags["provenance-digest"] ?? ""),
    expectedIpnsPredecessorCid: String(flags["expected-ipns-predecessor-cid"] ?? ""),
    expectedIpnsPredecessorSequence:
      typeof predecessorSequenceFlag === "string" &&
      /^(?:0|[1-9][0-9]*)$/.test(predecessorSequenceFlag)
        ? Number(predecessorSequenceFlag)
        : Number.NaN,
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
