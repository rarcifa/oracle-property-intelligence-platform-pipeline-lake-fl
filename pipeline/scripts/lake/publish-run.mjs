#!/usr/bin/env node
/**
 * Publish one Lake County run to public IPFS through Filebase, then prove it
 * is retrievable.
 *
 * The kit's publisher uploads plain S3 objects and accepts whatever CID
 * Filebase assigns, which is a CIDv0. This assignment requires CIDv1 base32,
 * a per-run artifact manifest with sizes and digests, a CAR for every
 * directory root, immutable prior CIDs, and retrieval proven from at least
 * two independent public gateways. The Lake-specific deterministic companion
 * extends `county-open-data-publish`'s conventions using the
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
 *     [--approve <owner-approval.json>]
 *     [--approval-public-key <ed25519-public-key.pem>] [--env-file <path>]
 *
 * @module scripts/lake/publish-run
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  buildUnixfsDirectory,
  computeRawCid,
  computeUnixfsFileCid,
  sha256Hex,
} from "../../src/core/cid.mjs";
import {
  computeCarDagBlockBytes,
  validateCarArchive,
  verifyImportedCarStream,
  writeCarFile,
} from "../../src/core/car.mjs";
import { buildArtifactManifest, writeArtifactManifest } from "../../src/core/artifact-manifest.mjs";
import {
  DEFAULT_GATEWAYS,
  verifyArtifactAcrossGateways,
  verifyManifestAcrossGateways,
} from "../../src/core/gateway-verify.mjs";
import {
  assertBusinessTableGate,
  assertPermitTableGate,
  assertQueryTableGate,
} from "../../src/counties/lake/adapter.mjs";
import {
  appendRun,
  computeTableDeltas,
  publishedBusinessAccountRows,
} from "../../src/core/run-history.mjs";
import { loadRecoveryAnchor } from "../../src/core/predecessor-recovery.mjs";
import {
  PINATA_SECONDARY_PIN_API_BASE,
  PINATA_SECONDARY_PIN_API_ORIGIN,
  PINATA_SECONDARY_PIN_API_PATH,
  LIGHTHOUSE_SECONDARY_PIN_API_BASE,
  LIGHTHOUSE_SECONDARY_PIN_API_ORIGIN,
  LIGHTHOUSE_SECONDARY_PIN_API_PATH,
  REQUIRED_PUBLISH_ACTIONS,
  REPLICATION_ONLY_ACTIONS,
  REPLICATION_TERMINAL_STAGE,
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
  verifyConsumedPublicationResume,
  verifyReplicationResume,
} from "../../src/core/publish-gate.mjs";
import {
  ensureSecondaryPin,
  ensureLighthouseRegistration,
  publicLighthouseReceipt,
  assertSecondaryRetention,
  writeLighthouseCheckpoint,
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
const IMMUTABLE_CAR_DEADLINE_MS = 10 * 60 * 1000;
/** The county this publisher releases. Also the publish gate's key. */
const COUNTY = "lake";

/**
 * Credentials are capabilities, not authority. Network publication is
 * reachable only when this invocation supplies exact human approval evidence
 * and is not explicitly capped as a dry run.
 *
 * @param {{ dryRun: boolean, approvalPath: string | null, approvalPublicKeyPath: string | null }} intent
 */
export function mayAttemptLivePublication(intent) {
  return Boolean(!intent.dryRun && intent.approvalPath);
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

/** Explicit provider selection changes the signed target; old Pinata approvals do not transfer. */
export function secondaryPinTarget(runId, provider = "pinata") {
  if (provider === "pinata") return pinataSecondaryPinTarget(runId);
  if (provider !== "lighthouse") throw new Error("Unsupported secondary pin provider");
  return {
    provider: "lighthouse",
    apiBase: LIGHTHOUSE_SECONDARY_PIN_API_BASE,
    apiOrigin: LIGHTHOUSE_SECONDARY_PIN_API_ORIGIN,
    apiPath: LIGHTHOUSE_SECONDARY_PIN_API_PATH,
    rootPinName: `${LAKE_IPNS_LABEL}/${runId}/root`,
    manifestPinName: `${LAKE_IPNS_LABEL}/${runId}/manifest`,
  };
}

function runtimeSecondaryEndpoint(provider, environment) {
  return provider === "lighthouse"
    ? (environment.LIGHTHOUSE_PIN_SERVICE_URL ?? LIGHTHOUSE_SECONDARY_PIN_API_BASE)
    : environment.SECONDARY_PIN_SERVICE_URL;
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
  const requestPath =
    validated.secondaryPin.provider === "pinata"
      ? `${parsed.pathname.replace(/\/$/, "")}/pins`
      : `${parsed.pathname.replace(/\/$/, "")}${LIGHTHOUSE_SECONDARY_PIN_API_PATH}`;
  if (
    parsed.origin !== validated.secondaryPin.apiOrigin ||
    requestPath !== validated.secondaryPin.apiPath ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    const provider = validated.secondaryPin.provider === "pinata" ? "Pinata" : "Lighthouse";
    throw new Error(
      `Secondary pin runtime endpoint does not match the signed ${provider} origin/path`,
    );
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
  const provider = validatePublicationTarget(target).secondaryPin.provider;
  if (envFile) await loadEnvironmentFile(envFile, environment);
  assertSecondaryPinRuntimeTarget(target, runtimeSecondaryEndpoint(provider, environment));
  fillDerivedFilebaseToken(environment);
  if (!environment.S3_ACCESS_KEY_ID || !environment.S3_SECRET_ACCESS_KEY) {
    throw new Error("Filebase credentials are required for a live publish");
  }
  const token =
    provider === "lighthouse" ? environment.IPFS_API_KEY : environment.SECONDARY_PIN_SERVICE_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0)
    throw new Error(
      provider === "lighthouse"
        ? "IPFS_API_KEY is required for Lighthouse before the primary upload"
        : "A scoped Pinata JWT is required before the primary upload",
    );
  return {
    secondaryPinEndpoint: exactEndpoint,
    secondaryPinToken: token.trim(),
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
export function assertPublicationPredecessor(
  previousRun,
  readback,
  target,
  attemptState,
  recoveryAnchor = null,
) {
  if (readback === null) throw new Error("The existing IPNS pointer could not be read back");
  if (previousRun?.rootCid !== target.ipnsPredecessor.cid) {
    if (
      !recoveryAnchor ||
      !target.predecessorRecoveryDigest ||
      recoveryAnchor.receiptDigest !== target.predecessorRecoveryDigest ||
      recoveryAnchor.rootCid !== target.ipnsPredecessor.cid ||
      recoveryAnchor.pointer.networkKey !== target.ipnsNetworkKey ||
      recoveryAnchor.pointer.sequence !== target.ipnsPredecessor.sequence
    ) {
      throw new Error(
        "The signed IPNS predecessor does not match immutable local history or a verified recovery anchor",
      );
    }
  }
  if (readback.networkKey !== target.ipnsNetworkKey) {
    throw new Error("The existing IPNS network key does not match the exact publication target");
  }
  if (
    readback.cid === target.rootCid &&
    readback.sequence === target.ipnsPredecessor.sequence + 1 &&
    ["HISTORY_RECORDED", "APPROVAL_CONSUMED", "FINALIZED"].includes(attemptState)
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
    throw new Error("publication approval evidence must stay outside the repository");
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
    // Register all ancestors before taking the deepest-first fold snapshot.
    // Otherwise a/b/file creates a/b but silently omits a from the root.
    let ancestor = parent;
    while (ancestor !== "") {
      if (!directories.has(ancestor)) directories.set(ancestor, []);
      ancestor = ancestor.includes("/") ? ancestor.slice(0, ancestor.lastIndexOf("/")) : "";
    }
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
 * Verify a complete S3 body without allocating another whole-object buffer.
 *
 * @param {unknown} body - AWS SDK GetObject Body.
 * @param {Buffer} expected - Locally frozen bytes.
 * @param {AbortSignal} signal - Header-and-body deadline.
 * @returns {Promise<void>}
 */
async function verifyS3Body(body, expected, signal) {
  let received = 0;
  const hash = createHash("sha256");
  const destroy = () => {
    if (typeof body?.destroy === "function") body.destroy();
  };
  const consume = (chunk) => {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const offset = received;
    received += bytes.length;
    if (received > expected.length || !bytes.equals(expected.subarray(offset, received)))
      throw Object.assign(new Error("different bytes"), { code: "CAR_BYTES_MISMATCH" });
    hash.update(bytes);
  };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    signal.throwIfAborted();
    if (body instanceof Uint8Array) consume(body);
    else if (
      typeof body?.[Symbol.asyncIterator] === "function" &&
      typeof body.destroy === "function"
    ) {
      for await (const chunk of body) consume(chunk);
    } else throw Object.assign(new Error("unreadable body"), { code: "CAR_BODY_UNREADABLE" });
    signal.throwIfAborted();
    if (received !== expected.length || hash.digest("hex") !== sha256Hex(expected))
      throw Object.assign(new Error("different bytes"), { code: "CAR_BYTES_MISMATCH" });
  } catch (error) {
    destroy();
    // Never include vendor messages, response bodies, credentials or PII.
    const rawCode = signal.aborted ? "CAR_READ_TIMEOUT" : (error?.code ?? error?.name);
    const code = [
      "CAR_READ_TIMEOUT",
      "CAR_BYTES_MISMATCH",
      "CAR_BODY_UNREADABLE",
      "ECONNRESET",
      "ECONNABORTED",
      "ETIMEDOUT",
      "ERR_STREAM_PREMATURE_CLOSE",
    ].includes(rawCode)
      ? rawCode
      : "CAR_STREAM_INTERRUPTED";
    throw new Error(
      `Immutable CAR readback incomplete or different bytes: expected=${expected.length} received=${received} code=${code}`,
    );
  } finally {
    signal.removeEventListener("abort", destroy);
  }
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

function isMissingObject(error) {
  const status = error?.$metadata?.httpStatusCode;
  return (
    status === 404 ||
    (status === undefined && (error?.name === "NoSuchKey" || error?.Code === "NoSuchKey"))
  );
}

/**
 * Reconcile first; create only after definite absence and a fresh write guard.
 *
 * IfNoneMatch is defense-in-depth, not a claim of vendor atomicity. The actual
 * publisher configures SDK maxAttempts=1, so an uncertain PUT is not replayed.
 * A later invocation must GET and verify first, including after lost PUT acks.
 *
 * @param {object} options - Options.
 * @param {S3Client} options.client - Configured S3 client.
 * @param {string} options.bucket - Authorization-bound destination bucket.
 * @param {string} options.key - Authorization-bound immutable object key.
 * @param {Buffer} options.body - Exact CAR bytes.
 * @param {string} [options.expectedCid] - Locally computed CAR root CID.
 * @param {() => Promise<void>} options.beforeCreate - Fresh authorization and predecessor guard.
 * @param {number} [options.deadlineMs] - Bounded per-request deadline (offline fixtures may shorten it).
 * @param {"imported-dag"} [options.primaryReadback] - Explicit signed imported-DAG contract; omission retains legacy transport GET.
 * @param {typeof fetch} [options.fetchImpl] - Injected gateway transport for offline tests.
 * @returns {Promise<{action: "created" | "reconciled-existing", key: string, bytes: number, sha256: string, reportedCid: string | null}>}
 */
export async function uploadImmutableCar({
  client,
  bucket,
  key,
  body,
  expectedCid,
  beforeCreate,
  deadlineMs = IMMUTABLE_CAR_DEADLINE_MS,
  primaryReadback = undefined,
  fetchImpl = fetch,
}) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new Error("Immutable CAR upload requires non-empty Buffer bytes");
  }
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > IMMUTABLE_CAR_DEADLINE_MS
  )
    throw new Error("Immutable CAR deadline must be positive and at most ten minutes");
  if (primaryReadback !== undefined && primaryReadback !== "imported-dag")
    throw new Error("Unsupported primary CAR readback contract");
  if (
    primaryReadback === "imported-dag" &&
    (typeof expectedCid !== "string" ||
      !/^b[a-z2-7]{20,}$/.test(expectedCid) ||
      JSON.stringify(validateCarArchive(body).roots) !== JSON.stringify([expectedCid]))
  )
    throw new Error("Imported CAR requires the exact single frozen root CID");
  const expectedSha256 = sha256Digest(body);
  const importedReadback = async () => {
    const signal = AbortSignal.timeout(deadlineMs);
    let head;
    try {
      head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal,
      });
    } catch (error) {
      if (!signal.aborted && isMissingObject(error)) return null;
      const status = error?.$metadata?.httpStatusCode;
      throw new Error(
        `Imported CAR HEAD failed: status=${Number.isInteger(status) ? status : "unknown"} code=${signal.aborted ? "CAR_DAG_TIMEOUT" : "CAR_DAG_HEAD_FAILED"}`,
      );
    }
    // HEAD binds the immutable key to the expected imported root, not bytes.
    // Only the subsequent complete block verification produces a receipt.
    if (
      head.ContentLength !== body.length ||
      head.Metadata?.cid?.trim() !== expectedCid ||
      head.Metadata?.import !== "car"
    )
      throw new Error("Imported CAR key metadata differs from the frozen target");
    let response;
    let stream;
    try {
      response = await fetchImpl(`https://ipfs.filebase.io/ipfs/${expectedCid}?format=car`, {
        redirect: "error",
        headers: { Accept: "application/vnd.ipld.car;version=1;order=dfs;dups=n" },
        signal,
      });
      if (
        response.status !== 200 ||
        !/^application\/vnd\.ipld\.car(?:;|$)/i.test(response.headers.get("content-type") ?? "")
      )
        throw new Error("CAR_DAG_GATEWAY_RESPONSE");
      stream = Readable.fromWeb(response.body);
      const readback = await verifyImportedCarStream({ body: stream, expected: body, signal });
      return { reportedCid: expectedCid, readback };
    } catch (error) {
      if (stream) stream.destroy();
      else await response?.body?.cancel().catch(() => {});
      if (error?.message?.startsWith("Imported CAR DAG readback failed:")) throw error;
      throw new Error(
        `Imported CAR gateway readback failed: code=${signal.aborted ? "CAR_DAG_TIMEOUT" : "CAR_DAG_GATEWAY_FAILED"}`,
      );
    }
  };
  const readback = async () => {
    // Not a fallback on HTTP500: the new representation is signed explicitly.
    if (primaryReadback === "imported-dag") return importedReadback();
    const readbackCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
    let headerCid = null;
    readbackCommand.middlewareStack.add(
      (next) => async (args) => {
        const result = await next(args);
        const header = result.response?.headers?.["x-amz-meta-cid"];
        if (typeof header === "string") headerCid = header.trim();
        return result;
      },
      { step: "deserialize", name: "captureReadbackCid", priority: "low" },
    );
    const signal = AbortSignal.timeout(deadlineMs);
    let response;
    try {
      response = await client.send(readbackCommand, { abortSignal: signal });
    } catch (error) {
      if (!signal.aborted && isMissingObject(error)) return null;
      const status = error?.$metadata?.httpStatusCode;
      throw new Error(
        `Immutable CAR GET failed before body: expected=${body.length} received=0 status=${Number.isInteger(status) ? status : "unknown"} code=${signal.aborted ? "CAR_READ_TIMEOUT" : "CAR_GET_FAILED"}`,
      );
    }
    let object;
    try {
      object = immutableCarGetSchema.parse(response);
      if (object.ContentLength !== undefined && object.ContentLength !== body.length)
        throw new Error(
          `Immutable CAR declared different bytes: expected=${body.length} received=0 declared=${object.ContentLength}`,
        );
      await verifyS3Body(object.Body, body, signal);
      const cids = [headerCid, object.Metadata?.cid?.trim()].filter((cid) => cid != null);
      if (expectedCid !== undefined && cids.some((cid) => cid !== expectedCid))
        throw new Error("Filebase reported CAR root different from the frozen target");
      return { reportedCid: cids[0] ?? null };
    } catch (error) {
      if (typeof response?.Body?.destroy === "function") response.Body.destroy();
      throw error;
    }
  };
  const receipt = (action, verified) => ({
    action,
    key,
    bytes: body.length,
    sha256: expectedSha256,
    reportedCid: verified.reportedCid,
    ...(verified.readback ? { readback: verified.readback, transportVerified: false } : {}),
  });
  const existing = await readback();
  if (existing !== null) return receipt("reconciled-existing", existing);
  if (typeof beforeCreate !== "function")
    throw new Error("Immutable CAR creation requires a fresh authorization/predecessor guard");
  if (typeof client.config?.maxAttempts !== "function" || (await client.config.maxAttempts()) !== 1)
    throw new Error(
      "Immutable CAR creation requires SDK maxAttempts=1; blind PUT retries are forbidden",
    );
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
  await beforeCreate();
  try {
    await client.send(command, { abortSignal: AbortSignal.timeout(deadlineMs) });
  } catch (error) {
    if (!isPreconditionFailure(error))
      throw new Error(
        "Immutable CAR create outcome uncertain; reconcile by GET on the next authorized invocation",
      );
    action = "reconciled-existing";
  }
  const verified = await readback();
  if (verified === null)
    throw new Error("Immutable CAR missing after create; no upload receipt recorded");
  if (expectedCid !== undefined && reportedCid !== null && reportedCid !== expectedCid)
    throw new Error("Filebase reported CAR root different from the frozen target");
  return receipt(action, { ...verified, reportedCid: verified.reportedCid ?? reportedCid });
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
 * @param {string | null} options.approvalPath - External recorded human or legacy signed exact-target approval.
 * @param {string | null} options.approvalPublicKeyPath - Trusted Ed25519 public key for legacy signed approval only.
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
  predecessorRecoveryPath = null,
  recoveryPublicKeyPath = null,
  secondaryPinProvider = "pinata",
  executionScope = undefined,
  primaryReadback = undefined,
}) {
  if (mode !== "full" && mode !== "incremental") {
    throw new Error("Publication mode must be full or incremental");
  }
  if (executionScope !== undefined && executionScope !== "replication-only") {
    throw new Error("Unsupported publication execution scope");
  }
  if (primaryReadback !== undefined && primaryReadback !== "imported-dag")
    throw new Error("Unsupported primary CAR readback contract");
  const selectedSecondaryTarget = secondaryPinTarget(runId, secondaryPinProvider);
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
  const historyPath = path.join(ARTIFACTS_DIR, "run-history.json");
  const previousRun = await readPreviousRun(historyPath);
  const startingLedger = await readPublicationLedger(PUBLICATION_LEDGER_PATH);
  const terminalCandidates = Object.values(startingLedger.attempts).filter(
    (entry) =>
      ["APPROVAL_CONSUMED", "FINALIZED", REPLICATION_TERMINAL_STAGE].includes(entry.state) &&
      entry.target.executionScope === executionScope &&
      entry.target.primaryReadback === primaryReadback &&
      entry.target.runId === runId &&
      entry.target.candidateCommit === candidateCommit &&
      entry.target.provenanceDigest === provenanceDigest &&
      entry.target.mode === mode &&
      entry.target.candidateWorkflowRunId === candidateWorkflowRunId &&
      entry.target.ipnsPredecessor?.cid === expectedIpnsPredecessorCid &&
      entry.target.ipnsPredecessor?.sequence === expectedIpnsPredecessorSequence &&
      entry.target.secondaryPin?.provider === secondaryPinProvider,
  );
  if (terminalCandidates.length > 1) throw new Error("Ambiguous terminal publication recovery");
  const terminalCandidate = terminalCandidates[0] ?? null;
  let allowedHistoryAppend = null;
  if (terminalCandidate && !dryRun && approvalPath) {
    if (executionScope === "replication-only") {
      const recorded = verifyReplicationResume(
        startingLedger,
        terminalCandidate.attemptId,
        JSON.parse(await readFile(assertExternalApprovalPath(approvalPath), "utf8")),
        approvalPublicKeyPath ? await readFile(approvalPublicKeyPath) : null,
      );
      return replicationResult(recorded);
    }
    verifyConsumedPublicationResume(
      startingLedger,
      terminalCandidate.attemptId,
      JSON.parse(await readFile(assertExternalApprovalPath(approvalPath), "utf8")),
      approvalPublicKeyPath ? await readFile(approvalPublicKeyPath) : null,
    );
    allowedHistoryAppend =
      terminalCandidate.transitions.find((transition) => transition.stage === "HISTORY_RECORDED")
        ?.receipt?.runRecord ?? null;
    if (
      !allowedHistoryAppend ||
      allowedHistoryAppend.runId !== runId ||
      allowedHistoryAppend.rootCid !== terminalCandidate.target.rootCid
    ) {
      throw new Error("Terminal publication has no exact durable history receipt");
    }
  }
  let recoveryAnchor = null;
  if (predecessorRecoveryPath) {
    if (!recoveryPublicKeyPath) throw new Error("A trusted recovery public key is required");
    recoveryAnchor = await loadRecoveryAnchor({
      receiptPath: assertExternalApprovalPath(predecessorRecoveryPath),
      publicKey: await readFile(recoveryPublicKeyPath),
      historyPath,
      allowedHistoryAppend,
    });
    if (
      recoveryAnchor.rootCid !== expectedIpnsPredecessorCid ||
      recoveryAnchor.pointer.sequence !== expectedIpnsPredecessorSequence ||
      recoveryAnchor.pointer.networkKey !== LAKE_IPNS_NETWORK_KEY
    ) {
      throw new Error("Recovery anchor does not match the exact expected predecessor");
    }
  }
  if (previousRun?.rootCid !== expectedIpnsPredecessorCid) {
    if (!recoveryAnchor)
      throw new Error(
        `Expected IPNS predecessor ${expectedIpnsPredecessorCid} does not match immutable local history ${previousRun?.rootCid ?? "none"}`,
      );
  }
  const coverage = JSON.parse(await readFile(path.join(runDir, "coverage.json"), "utf8"));
  const accountingPredecessor = recoveryAnchor ?? previousRun;
  assertTablesPlausible(coverageTableRows(coverage), accountingPredecessor);

  // The kit's one-row-per-property invariant: no null folio, and exactly as many
  // rows as distinct folios. It was written, exported, and never called — a gate
  // beside the path rather than on it, which is the same defect the approval gate
  // had. A table that silently duplicated or dropped parcels would have published.
  const gateCounts = await assertQueryTableGate(path.join(runDir, "query-table.parquet"));
  log("query_table_gate", gateCounts);
  const permitGateCounts = await assertPermitTableGate(path.join(runDir, "permit-table.parquet"));
  log("permit_table_gate", permitGateCounts);
  if (coverage.tables.businessAccounts?.accountTableAvailable === true) {
    const businessGateCounts = await assertBusinessTableGate(
      path.join(runDir, "business-table.parquet"),
      publishedBusinessAccountRows(coverage.tables.businessAccounts),
    );
    log("business_table_gate", businessGateCounts);
  }

  const dag = await buildRunDag(runDir);
  log("dag_built", {
    rootCid: dag.rootCid,
    blocks: dag.blocks.length,
    artifacts: dag.entries.length,
  });

  const carPath = path.join(carDir, `${runId}.car`);
  const car = await writeCarFile({ roots: [dag.rootCid], blocks: dag.blocks, outputPath: carPath });
  log("car_written", { path: car.path, bytes: car.bytes, rootCid: car.rootCid });

  // Deliver the archive as actual file bytes under its own CID. This has no
  // self-reference: the data DAG is complete before its archive is encoded.
  // One multi-root CAR declares every directory snapshot, including subroots.
  const directoryRoots = [
    ...new Set([
      dag.rootCid,
      ...dag.entries.filter((entry) => entry.codec === "directory").map((entry) => entry.cid),
    ]),
  ];
  const snapshotCar = await writeCarFile({
    roots: directoryRoots,
    blocks: dag.blocks,
    outputPath: path.join(carDir, `${runId}-snapshot.car`),
  });
  const snapshotBody = await readFile(snapshotCar.path);
  const archiveValidation = validateCarArchive(snapshotBody);
  if (JSON.stringify(archiveValidation.roots) !== JSON.stringify(directoryRoots)) {
    throw new Error("Snapshot CAR root readback differs from the directory manifest");
  }
  const archiveFile = computeUnixfsFileCid(snapshotBody);
  const archiveTransport = await writeCarFile({
    roots: [archiveFile.cid],
    blocks: archiveFile.blocks,
    outputPath: path.join(carDir, `${runId}-archive-transport.car`),
  });
  const archiveEntry = {
    cid: archiveFile.cid,
    name: "snapshot.car",
    size: snapshotBody.length,
    codec: "file",
    sha256: sha256Digest(snapshotBody),
  };

  // The manifest's own CID must be reproducible for a given run, so its
  // timestamp comes from the run id rather than the clock. A wall-clock value
  // here changes the manifest bytes on every invocation, which changes its CID
  // and orphans the copy already pinned on IPFS.
  const manifest = buildArtifactManifest({
    runId,
    county: "lake",
    generatedAt: runIdToIso(runId),
    rootCid: dag.rootCid,
    rootCarPath: `ipfs://${archiveFile.cid}`,
    entries: [...dag.entries, archiveEntry],
    directoryCars: directoryRoots.map((directoryCid) => ({
      directoryCid,
      carCid: archiveFile.cid,
    })),
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
  const archiveTransportBody = await readFile(archiveTransport.path);
  // Provider registration size is unique DAG block bytes for these observed
  // imports, never the manifest's logical file bytes or CAR transport framing.
  // Derive from frozen, hash-validated rooted CARs; no new signed target field.
  const lighthouseDagBytes =
    secondaryPinProvider === "lighthouse"
      ? {
          root: computeCarDagBlockBytes(rootCarBody, dag.rootCid),
          manifest: computeCarDagBlockBytes(manifestCarBody, manifestCid),
          archive: computeCarDagBlockBytes(archiveTransportBody, archiveFile.cid),
        }
      : null;
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
    archive: {
      key: `runs/${runId}/archive.car`,
      bytes: archiveTransportBody.length,
      sha256: sha256Digest(archiveTransportBody),
      cid: archiveFile.cid,
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
    ...(primaryReadback ? { primaryReadback } : {}),
    secondaryPin: {
      ...selectedSecondaryTarget,
      archivePinName: `${LAKE_IPNS_LABEL}/${runId}/archive`,
    },
    ipnsLabel: LAKE_IPNS_LABEL,
    ipnsNetworkKey: LAKE_IPNS_NETWORK_KEY,
    ipnsPredecessor: {
      cid: expectedIpnsPredecessorCid,
      sequence: expectedIpnsPredecessorSequence,
    },
    ...(recoveryAnchor ? { predecessorRecoveryDigest: recoveryAnchor.receiptDigest } : {}),
    ...(executionScope ? { executionScope } : {}),
    actions: [
      ...(executionScope === "replication-only"
        ? REPLICATION_ONLY_ACTIONS
        : REQUIRED_PUBLISH_ACTIONS),
    ],
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
    `${runId}${executionScope ? `.${executionScope}` : ""}.publication-request.json`,
  );
  await writeFile(
    approvalRequestPath,
    `${JSON.stringify({ schemaVersion: "elephant.publication-request.v1", attemptId, target }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  // An explicit dry-run is an unbreakable ceiling. Credentials by themselves
  // have no authority, and a missing human approval only prepares a review target.
  if (!mayAttemptLivePublication({ dryRun, approvalPath, approvalPublicKeyPath })) {
    const attempt = (await readPublicationLedger(PUBLICATION_LEDGER_PATH)).attempts[attemptId];
    log("publication_prepared_local", {
      attemptId,
      approvalRequestPath,
      nextAction: nextPublicationRecoveryAction(attempt),
      reason: dryRun ? "explicit dry-run" : "exact human approval not supplied",
    });
    return {
      runId,
      mode,
      candidateWorkflowRunId,
      candidateCommit,
      rootCid: dag.rootCid,
      manifestCid,
      carCid: archiveFile.cid,
      dryRun: true,
      ...(executionScope ? { executionScope } : {}),
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
    runtimeSecondaryEndpoint(target.secondaryPin.provider, process.env),
  );
  const approval = JSON.parse(await readFile(assertExternalApprovalPath(approvalPath), "utf8"));
  const publicKey = approvalPublicKeyPath ? await readFile(approvalPublicKeyPath) : null;
  const builtLedger = await readPublicationLedger(PUBLICATION_LEDGER_PATH);
  let attempt = ["APPROVAL_CONSUMED", "FINALIZED"].includes(builtLedger.attempts[attemptId].state)
    ? verifyConsumedPublicationResume(builtLedger, attemptId, approval, publicKey)
    : await authorizePublicationAttempt(PUBLICATION_LEDGER_PATH, attemptId, approval, publicKey);
  const gatedDryRun = false;
  let predecessorState = null;
  /** @type {Awaited<ReturnType<typeof loadLivePublicationCapabilities>> | null} */
  let capabilities = null;

  /** @type {Record<string, unknown>} */
  const publishResult = {
    dryRun: gatedDryRun,
    rootCid: dag.rootCid,
    manifestCid,
    carCid: archiveFile.cid,
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
        "APPROVAL_CONSUMED",
        "FINALIZED",
      ].includes(attempt.state)
    ) {
      const pointer = await readIpnsPointer(capabilities.filebaseApiToken);
      predecessorState = assertPublicationPredecessor(
        previousRun,
        pointer,
        target,
        attempt.state,
        recoveryAnchor,
      );
      if (
        ["APPROVAL_CONSUMED", "FINALIZED"].includes(attempt.state) &&
        predecessorState !== "target-already-applied"
      )
        throw new Error("Terminal publication pointer no longer matches its verified target");
    }
    const client = new S3Client({
      endpoint: FILEBASE_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: capabilities.filebaseCredentials,
      // Filebase's conditional atomicity is unverified; never replay an uncertain PUT.
      maxAttempts: 1,
    });
    const beforeCarCreate = async () => {
      assertPublicationAuthorizationActive(attempt);
      assertPublicationPredecessor(
        previousRun,
        await readIpnsPointer(capabilities.filebaseApiToken),
        target,
        attempt.state,
        recoveryAnchor,
      );
      assertPublicationAuthorizationActive(attempt);
    };
    if (attempt.state === "AUTHORIZED") {
      assertPublicationAuthorizationActive(attempt);
      assertPublicationPredecessor(
        previousRun,
        await readIpnsPointer(capabilities.filebaseApiToken),
        target,
        attempt.state,
        recoveryAnchor,
      );
      assertPublicationAuthorizationActive(attempt);
      const rootUpload = await uploadImmutableCar({
        client,
        bucket: target.bucket,
        key: target.primaryCars.root.key,
        body: rootCarBody,
        expectedCid: target.primaryCars.root.cid,
        beforeCreate: beforeCarCreate,
        primaryReadback: target.primaryReadback,
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
      assertPublicationAuthorizationActive(attempt);
      assertPublicationPredecessor(
        previousRun,
        await readIpnsPointer(capabilities.filebaseApiToken),
        target,
        attempt.state,
        recoveryAnchor,
      );
      assertPublicationAuthorizationActive(attempt);
      const archiveUpload = await uploadImmutableCar({
        client,
        bucket: target.bucket,
        key: target.primaryCars.archive.key,
        body: archiveTransportBody,
        expectedCid: archiveFile.cid,
        beforeCreate: beforeCarCreate,
        primaryReadback: target.primaryReadback,
      });
      if (archiveUpload.reportedCid !== null && archiveUpload.reportedCid !== archiveFile.cid) {
        throw new Error("Filebase reported an archive CID different from the signed target");
      }
      attempt = await advancePublicationAttempt(
        PUBLICATION_LEDGER_PATH,
        attemptId,
        "ROOT_UPLOAD_RECORDED",
        {
          ...target.primaryCars.root,
          action: rootUpload.action,
          computedCid: dag.rootCid,
          reportedCid: rootReported,
          ...(rootUpload.readback
            ? { readback: rootUpload.readback, transportVerified: false }
            : {}),
          archive: {
            ...target.primaryCars.archive,
            action: archiveUpload.action,
            reportedCid: archiveUpload.reportedCid,
            ...(archiveUpload.readback
              ? { readback: archiveUpload.readback, transportVerified: false }
              : {}),
          },
        },
      );
    }
    if (attempt.state === "ROOT_UPLOAD_RECORDED") {
      assertPublicationAuthorizationActive(attempt);
      assertPublicationPredecessor(
        previousRun,
        await readIpnsPointer(capabilities.filebaseApiToken),
        target,
        attempt.state,
        recoveryAnchor,
      );
      assertPublicationAuthorizationActive(attempt);
      const manifestUpload = await uploadImmutableCar({
        client,
        bucket: target.bucket,
        key: target.primaryCars.manifest.key,
        body: manifestCarBody,
        expectedCid: target.primaryCars.manifest.cid,
        beforeCreate: beforeCarCreate,
        primaryReadback: target.primaryReadback,
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
          ...(manifestUpload.readback
            ? { readback: manifestUpload.readback, transportVerified: false }
            : {}),
        },
      );
    }
    if (attempt.state === "MANIFEST_UPLOAD_RECORDED") {
      const pinOptions = {
        endpoint: target.secondaryPin.apiBase,
        token: capabilities.secondaryPinToken,
        beforeCreate: async () => {
          assertPublicationAuthorizationActive(attempt);
          assertPublicationPredecessor(
            previousRun,
            await readIpnsPointer(capabilities.filebaseApiToken),
            target,
            attempt.state,
            recoveryAnchor,
          );
          assertPublicationAuthorizationActive(attempt);
        },
      };
      const reconcilePin = async (kind, options) => {
        if (target.secondaryPin.provider === "pinata") return ensureSecondaryPin(options);
        // Private checkpoints preserve accepted requests without promoting them.
        // A retry must not POST again while an accepted request is still absent
        // from the asynchronous inventory. These files never enter the data DAG.
        const receiptPath = path.join(
          path.dirname(manifestPath),
          `${runId}.${attemptId.slice(7)}.lighthouse-${kind}.json`,
        );
        let previousEvidence = null;
        try {
          previousEvidence = JSON.parse(await readFile(receiptPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        // Existing reconciled entries may predate this invocation's POST.
        const acceptedEvidence =
          previousEvidence?.requestAccepted || previousEvidence?.requestIntent
            ? previousEvidence
            : null;
        return ensureLighthouseRegistration({
          ...options,
          previousEvidence: acceptedEvidence,
          allowPendingEvidence: target.executionScope === "replication-only",
          expectedDagBytes: lighthouseDagBytes[kind],
          onEvidence: (receipt) => writeLighthouseCheckpoint(receiptPath, receipt),
        });
      };
      const rootPin = await reconcilePin("root", {
        ...pinOptions,
        cid: dag.rootCid,
        name: target.secondaryPin.rootPinName,
      });
      const manifestPin = await reconcilePin("manifest", {
        ...pinOptions,
        cid: manifestCid,
        name: target.secondaryPin.manifestPinName,
      });
      const archivePin = await reconcilePin("archive", {
        ...pinOptions,
        cid: archiveFile.cid,
        name: target.secondaryPin.archivePinName,
      });
      if (target.executionScope === "replication-only") {
        const sanitize =
          target.secondaryPin.provider === "lighthouse"
            ? publicLighthouseReceipt
            : (receipt) => receipt;
        attempt = await advancePublicationAttempt(
          PUBLICATION_LEDGER_PATH,
          attemptId,
          REPLICATION_TERMINAL_STAGE,
          {
            root: sanitize(rootPin),
            manifest: sanitize(manifestPin),
            archive: sanitize(archivePin),
            retentionVerified: false,
            promotionHeld: true,
          },
        );
        return replicationResult(attempt);
      }
      assertSecondaryRetention([rootPin, manifestPin, archivePin], target.secondaryPin.provider);
      attempt = await advancePublicationAttempt(
        PUBLICATION_LEDGER_PATH,
        attemptId,
        "SECONDARY_PIN_RECORDED",
        { root: rootPin, manifest: manifestPin, archive: archivePin },
      );
    }
  }

  if (target.executionScope === "replication-only") {
    throw new Error("Replication-only execution cannot enter publication promotion");
  }

  const evidencePath = path.join(ARTIFACTS_DIR, `verification-${runId}.json`);
  /** @type {any} */
  let verification;
  if (attempt.state === "SECONDARY_PIN_RECORDED") {
    const files = await verifyManifestAcrossGateways({ manifest });
    if (!files.verified || files.checkedArtifacts !== manifest.artifacts.length) {
      throw new Error(
        "Independent retrieval must cover every listed CID, including directories and CAR bytes",
      );
    }
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
    if (!manifestVerification.verified) {
      throw new Error(
        "The manifest itself must match bytes through two independent public gateways",
      );
    }
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

  // A recovered root is a different baseline. The old mutable hash cache
  // belongs to recorded history, never to this newly verified handoff.
  const previousHashes = recoveryAnchor
    ? await readCurrentRowHashes(recoveryAnchor.queryPath)
    : await readPreviousRowHashes(historyPath, previousRun);
  const currentHashes = await readCurrentRowHashes(path.join(runDir, "query-table.parquet"));
  const deltas = computeTableDeltas(previousHashes, currentHashes);
  const tableAccounting = buildTableAccounting(coverage, deltas, accountingPredecessor);

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
    carCid: archiveFile.cid,
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
      // Gateway verification can take minutes. Recheck immediately before
      // promotion rather than relying on the pointer seen before uploads.
      const freshState = assertPublicationPredecessor(
        previousRun,
        await readIpnsPointer(capabilities.filebaseApiToken),
        target,
        attempt.state,
        recoveryAnchor,
      );
      if (freshState !== "recorded-predecessor")
        throw new Error("IPNS changed before promotion; retry to reconcile its receipt");
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
          carCid: archiveFile.cid,
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

/** This terminal result explicitly does not represent a successful publication. */
function replicationResult(attempt) {
  return {
    runId: attempt.target.runId,
    mode: attempt.target.mode,
    candidateWorkflowRunId: attempt.target.candidateWorkflowRunId,
    candidateCommit: attempt.target.candidateCommit,
    rootCid: attempt.target.rootCid,
    manifestCid: attempt.target.primaryCars.manifest.cid,
    carCid: attempt.target.primaryCars.archive.cid,
    executionScope: "replication-only",
    publicationState: REPLICATION_TERMINAL_STAGE,
    attemptId: attempt.attemptId,
    dryRun: false,
    retentionVerified: false,
    promotionHeld: true,
    evidence: attempt.transitions.at(-1).receipt,
    nextAction: nextPublicationRecoveryAction(attempt),
  };
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
  if (business)
    rows.push({ name: "businessAccounts", rows: publishedBusinessAccountRows(business) });
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
  if (business) tables.push(counted("businessAccounts", publishedBusinessAccountRows(business)));
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
    predecessorRecoveryPath:
      typeof flags["predecessor-recovery"] === "string" ? flags["predecessor-recovery"] : null,
    recoveryPublicKeyPath:
      typeof flags["recovery-public-key"] === "string" ? flags["recovery-public-key"] : null,
    secondaryPinProvider: String(flags["secondary-provider"] ?? "pinata"),
    executionScope: flags["execution-scope"],
    primaryReadback: flags["primary-readback"],
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
