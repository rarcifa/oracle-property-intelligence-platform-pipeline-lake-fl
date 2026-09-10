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
 *                                     [--dry-run] [--skip-ipns] [--verify-all]
 *
 * @module scripts/lake/publish-run
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { buildUnixfsDirectory, computeRawCid, computeUnixfsFileCid, sha256Hex } from "../../src/core/cid.mjs";
import { writeCarFile } from "../../src/core/car.mjs";
import { buildArtifactManifest, writeArtifactManifest } from "../../src/core/artifact-manifest.mjs";
import { verifyArtifactAcrossGateways } from "../../src/core/gateway-verify.mjs";
import { appendRun, computeTableDeltas } from "../../src/core/run-history.mjs";
import {
  evaluatePublishGate,
  readCountyGate,
  recordDryRun,
  recordPublication,
  requestPublish,
} from "../../src/core/publish-gate.mjs";
import {
  loadEnvFile,
  fillDerivedFilebaseToken,
  upsertFilebaseName,
  FILEBASE_NAMES_API,
} from "../../src/core/filebase.mjs";
import { LAKE_BUCKET, LAKE_IPNS_LABEL } from "../../src/counties/lake/enrichment-profile.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..", "..", "..", "..");
const PUBLISH_ROOT = path.join(RUNTIME_ROOT, "data", "artifacts", "publish", "lake");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
const FILEBASE_ENDPOINT = "https://s3.filebase.com";
/** The county this publisher releases. Also the publish gate's key. */
const COUNTY = "lake";
/**
 * Artifacts at or below this size are byte-verified from every gateway on
 * every run. Above it, verification is expensive: the published run carries 22
 * shards of roughly 14 MB each plus a 20 MB Parquet, and fetching all of them
 * from several gateways moves hundreds of megabytes per run for no extra
 * assurance. The large artifacts named in {@link ALWAYS_VERIFY_LARGE} are
 * verified in full regardless, so the evidence still covers the columnar table
 * and a representative shard end to end.
 */
const FULL_VERIFY_MAX_BYTES = 2 * 1024 * 1024;

/** Large artifacts byte-verified in full on every run despite their size. */
const ALWAYS_VERIFY_LARGE = Object.freeze(["query-table.parquet", "shards/shard-0000.json"]);

/**
 * @param {string} message - Event name.
 * @param {Record<string, unknown>} [fields] - Extra fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: message, ...fields })}\n`);
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
  for (const entry of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
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
  const nested = [...directories.keys()].filter((key) => key !== "").sort((a, b) => depth(b) - depth(a));
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
 * Upload one CAR to Filebase so the exact DAG computed locally is pinned.
 *
 * @param {object} options - Options.
 * @param {S3Client} options.client - Configured S3 client.
 * @param {string} options.key - Object key.
 * @param {Buffer} options.body - CAR bytes.
 * @returns {Promise<string | null>} The CID Filebase reports, when it reports one.
 */
export async function uploadCar({ client, key, body }) {
  const command = new PutObjectCommand({
    Bucket: LAKE_BUCKET,
    Key: key,
    Body: body,
    ContentType: "application/vnd.ipld.car",
    Metadata: { import: "car" },
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
  await client.send(command);
  return reportedCid;
}

/**
 * Publish a built run directory.
 *
 * @param {object} options - Options.
 * @param {string} options.runId - Run identifier.
 * @param {string} options.mode - `full` or `incremental`.
 * @param {boolean} options.dryRun - When true, compute and write locally but upload nothing.
 * @param {boolean} options.skipIpns - When true, do not re-point the IPNS name.
 * @param {boolean} options.skipUpload - When true, reuse an upload already on Filebase and only verify.
 * @param {boolean} options.verifyAll - When true, byte-verify every artifact regardless of size.
 * @param {boolean} options.reuseVerification - When true, reuse the recorded evidence from a prior verification of this exact run instead of re-fetching.
 * @returns {Promise<Record<string, unknown>>} The run record appended to history.
 */
export async function publishRun({ runId, mode, dryRun, skipIpns, skipUpload, verifyAll, reuseVerification }) {
  const runDir = path.join(PUBLISH_ROOT, "runs", runId);
  const carDir = path.join(PUBLISH_ROOT, "cars");
  await mkdir(carDir, { recursive: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  const started = new Date().toISOString();
  const dag = await buildRunDag(runDir);
  log("dag_built", { rootCid: dag.rootCid, blocks: dag.blocks.length, artifacts: dag.entries.length });

  // The human approval gate, ON the publish path rather than beside it.
  //
  // Bulk property data reaching public IPFS is human-gated: an unapproved run
  // dry-runs and leaves the county pending, and `pending` clears only after an
  // approved publication. The gate is evaluated here, after the DAG is hashed
  // and before anything is written or uploaded, because the run's root CID IS
  // the content watermark the state machine throttles on — an unapproved run
  // proves the same content once and then stops, instead of rebuilding a
  // 332 MB CAR on every invocation while it waits for a human.
  const gatePath = path.join(ARTIFACTS_DIR, "publish-gate.json");
  const gateState = await readCountyGate(gatePath, COUNTY);
  const gate = evaluatePublishGate(gateState, dag.rootCid);
  log("publish_gate", {
    county: COUNTY,
    action: gate.action,
    reason: gate.reason,
    approvedBy: gateState.approvedBy,
    pending: gateState.pending,
  });
  // Requesting a publication is what makes a county pending, so it happens
  // only when there is something to release. Marking a county pending for
  // content it has already published would leave it permanently pending with
  // nothing able to clear it.
  if (gate.action !== "published") await requestPublish(gatePath, COUNTY);
  if (gate.action === "skip" || gate.action === "published") {
    // Nothing to do: either this exact content was already dry-run and is still
    // waiting for a human, or it is already released. Either way, stop before
    // framing a 332 MB CAR that nobody is going to read.
    return { runId, rootCid: dag.rootCid, gate: gate.action, reason: gate.reason };
  }
  // An unapproved run is a dry run whatever the caller asked for. `--dry-run`
  // may only ever tighten this, never loosen it.
  const gatedDryRun = dryRun || gate.action !== "publish";

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
    // CAR as `.claude/skills/.../cars/<run>.car`, which a third party working
    // from the manifest alone cannot resolve — and the .car is build output that
    // is deliberately not committed. The CAR's DAG root IS the run root, so this
    // locator is retrievable from any gateway with `?format=car`.
    rootCarPath: `ipfs://${dag.rootCid}?format=car`,
    entries: dag.entries,
  });
  const manifestPath = path.join(runDir, "..", "..", "manifests", `${runId}.json`);
  await mkdir(path.dirname(manifestPath), { recursive: true });
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
  log("manifest_written", { manifestCid, bytes: manifestWrite.bytes });

  /** @type {Record<string, unknown>} */
  const publishResult = { dryRun: gatedDryRun, rootCid: dag.rootCid, manifestCid, carCid: car.rootCid };

  if (!gatedDryRun) {
    await loadEnvFile(path.join(REPO_ROOT, ".env"), process.env);
    fillDerivedFilebaseToken(process.env);
    if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
      throw new Error("Filebase credentials are required for a live publish");
    }
    const client = new S3Client({
      endpoint: FILEBASE_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    let rootReported = null;
    if (skipUpload) {
      log("root_car_upload_skipped", { key: `runs/${runId}/root.car`, computedCid: dag.rootCid });
    } else {
      rootReported = await uploadCar({
        client,
        key: `runs/${runId}/root.car`,
        body: await readFile(carPath),
      });
      log("car_uploaded", { key: `runs/${runId}/root.car`, reportedCid: rootReported, computedCid: dag.rootCid });
    }
    const manifestReported = await uploadCar({
      client,
      key: `runs/${runId}/manifest.car`,
      body: await readFile(manifestCar.path),
    });
    log("manifest_car_uploaded", { reportedCid: manifestReported, computedCid: manifestCid });
    publishResult.filebaseReportedRootCid = rootReported;
    publishResult.filebaseReportedManifestCid = manifestReported;

    if (!skipIpns && !skipUpload) {
      const name = await upsertFilebaseName(process.env.FILEBASE_API_TOKEN, LAKE_IPNS_LABEL, dag.rootCid);
      log("ipns_repointed", { label: LAKE_IPNS_LABEL, name: name.network_key, cid: dag.rootCid });
    }
  }

  // The IPNS pointer is always read back from the provider rather than assumed
  // from what was just written, so the run record states the name and the CID
  // it actually resolves to. A pointer is a claim until it is read back.
  /** @type {{ networkKey: string, cid: string, sequence: number } | null} */
  let ipnsState = null;
  if (!gatedDryRun && !skipIpns) {
    await loadEnvFile(path.join(REPO_ROOT, ".env"), process.env);
    fillDerivedFilebaseToken(process.env);
    ipnsState = await readIpnsPointer(process.env.FILEBASE_API_TOKEN);
    log("ipns_readback", ipnsState ?? { error: "label not found" });
    if (ipnsState !== null && ipnsState.cid !== dag.rootCid) {
      throw new Error(
        `IPNS label ${LAKE_IPNS_LABEL} resolves to ${ipnsState.cid}, not the published root ${dag.rootCid}`,
      );
    }
    publishResult.ipnsName = ipnsState?.networkKey ?? null;
    publishResult.resolvedCid = ipnsState?.cid ?? null;
  }

  /** @type {any[]} */
  let verifications = [];
  const evidencePath = path.join(ARTIFACTS_DIR, `verification-${runId}.json`);
  if (!gatedDryRun && reuseVerification) {
    // Reuse evidence already recorded for this exact run rather than re-fetching
    // hundreds of megabytes. The evidence is only accepted if it names the same
    // root CID, so it can never be silently carried across runs.
    const prior = JSON.parse(await readFile(evidencePath, "utf8"));
    if (prior.rootCid !== dag.rootCid) {
      throw new Error(
        `Recorded verification is for root ${prior.rootCid}, not ${dag.rootCid}; refusing to reuse it`,
      );
    }
    verifications = prior.verifications;
    log("verification_reused", { evidencePath, artifacts: verifications.length });
  } else if (!gatedDryRun) {
    const fileEntries = manifest.artifacts.filter((entry) => entry.codec === "file");
    const toVerify = verifyAll
      ? fileEntries
      : fileEntries.filter(
          (entry) => entry.size <= FULL_VERIFY_MAX_BYTES || ALWAYS_VERIFY_LARGE.includes(entry.name),
        );
    const manifestEntry = {
      cid: manifestCid,
      name: "manifest.json",
      size: manifestBytes.length,
      sha256: `sha256:${sha256Hex(manifestBytes)}`,
    };
    for (const entry of [manifestEntry, ...toVerify]) {
      const result = await verifyArtifactAcrossGateways({
        cid: entry.cid,
        expectedSize: entry.size,
        expectedSha256: entry.sha256,
      });
      verifications.push({ name: entry.name, ...result });
      log("artifact_verified", {
        name: entry.name,
        cid: entry.cid,
        verified: result.verified,
        gateways: result.matchedGateways,
      });
    }
  }

  const verifiedGateways = [
    ...new Set(
      verifications.flatMap((entry) =>
        entry.results.filter((result) => result.ok).map((result) => result.gateway),
      ),
    ),
  ];

  const coverage = JSON.parse(await readFile(path.join(runDir, "coverage.json"), "utf8"));
  const historyPath = path.join(ARTIFACTS_DIR, "run-history.json");
  const previousHashes = await readPreviousRowHashes(historyPath);
  const previousRun = await readPreviousRun(historyPath);
  const currentHashes = await readCurrentRowHashes(path.join(runDir, "query-table.parquet"));
  const deltas = computeTableDeltas(previousHashes, currentHashes);

  const runRecord = {
    runId,
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
        recordCount: coverage.tables.permits.rows,
      },
    ],
    tables: buildTableAccounting(coverage, deltas, previousRun),
    limitations: coverage.limitations,
    rootCid: dag.rootCid,
    manifestCid,
    carCid: car.rootCid,
    ipnsName: ipnsState?.networkKey ?? null,
    resolvedCid: ipnsState?.cid ?? null,
    verifiedGateways,
    status: runStatus(gatedDryRun, verifications),
  };
  if (!gatedDryRun) {
    // History first, then the row-hash baseline. If this is written before the
    // append, an interrupted run leaves a baseline with no matching history
    // entry, and the retry then diffs the run against itself and reports every
    // row as unchanged when it was in fact the first load.
    await appendRun(historyPath, runRecord);
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
          rootCid: dag.rootCid,
          manifestCid,
          carCid: car.rootCid,
          ipnsName: ipnsState?.networkKey ?? null,
          resolvedCid: ipnsState?.cid ?? null,
          verifiedGateways,
          propertyCount: coverage.tables.properties.rows,
          publishedAt: runRecord.finishedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(ARTIFACTS_DIR, `verification-${runId}.json`),
      `${JSON.stringify({ runId, rootCid: dag.rootCid, verifications }, null, 2)}\n`,
      "utf8",
    );
    await writeArtifactManifest(manifest, path.join(ARTIFACTS_DIR, `manifest-${runId}.json`));
    // The only thing that clears `pending`: an approved publication that
    // actually released this content.
    const released = await recordPublication(gatePath, COUNTY, {
      watermark: dag.rootCid,
      runId,
    });
    log("publish_gate_released", {
      county: COUNTY,
      pending: released.pending,
      watermark: released.lastPublishedWatermark,
    });
  } else if (gate.action !== "publish") {
    // Unapproved: this content has now been built and validated once. The
    // county stays pending, and the next run at the same watermark stops
    // before rebuilding it.
    const waiting = await recordDryRun(gatePath, COUNTY, dag.rootCid);
    log("publish_gate_awaiting_approval", {
      county: COUNTY,
      pending: waiting.pending,
      watermark: waiting.lastDryRunWatermark,
      approve: `node scripts/lake/publish-approve.mjs --county ${COUNTY} --by "<name>" --note "<what was approved>"`,
    });
  }
  log("publish_complete", { ...publishResult, gate: gate.action, status: runRecord.status, verifiedGateways });
  return runRecord;
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
  return { networkKey: entry.network_key, cid: entry.cid, sequence: Number(entry.sequence) };
}

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
  return tables;
}

/**
 * Read the row hashes recorded by the previous run, for delta computation.
 *
 * @param {string} historyPath - Run-history path (its sibling holds the hashes).
 * @returns {Promise<Map<string, string>>} Parcel id to row hash.
 */
export async function readPreviousRowHashes(historyPath) {
  try {
    const parsed = JSON.parse(await readFile(path.join(path.dirname(historyPath), "row-hashes.json"), "utf8"));
    return new Map(Object.entries(parsed.hashes));
  } catch {
    return new Map();
  }
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
  publishRun({
    runId: String(flags["run-id"] ?? ""),
    mode: String(flags.mode ?? "full"),
    dryRun: flags["dry-run"] === true,
    skipIpns: flags["skip-ipns"] === true,
    skipUpload: flags["skip-upload"] === true,
    verifyAll: flags["verify-all"] === true,
    reuseVerification: flags["reuse-verification"] === true,
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
