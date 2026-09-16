#!/usr/bin/env node
/** Read-only preparation, human signing, and local acceptance of one exact handoff. */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, fillDerivedFilebaseToken } from "../../src/core/filebase.mjs";
import { sha256Digest } from "../../src/core/publish-gate.mjs";
import {
  acceptRecovery,
  assertRecoveryPointer,
  buildRecoveryPayload,
  readRecoveryPacket,
  recoveryTarget,
  signRecoveryAuthorization,
} from "../../src/core/predecessor-recovery.mjs";
import { parseApprovalArgs } from "./publish-approve.mjs";
import { readIpnsPointer } from "./publish-run.mjs";
import { currentRepositoryCommit, verifyPublicationProvenance } from "./publication-provenance.mjs";
import { validateArtifactManifest } from "../../src/core/artifact-manifest.mjs";
import { readQueryTableCounts } from "../../src/counties/lake/adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HISTORY = path.join(REPO_ROOT, "artifacts", "run-history.json");
const GATEWAYS = ["https://ipfs.filebase.io", "https://gw.ipfs-lens.dev"];
const DISCLOSURE = {
  originalApproval: "unknown",
  originalSuccessfulPublicationReceipt: "unknown",
  historicalGatewayReadback: "unknown",
};
function external(candidate) {
  if (typeof candidate !== "string") throw new Error("An explicit external path is required");
  const resolved = path.resolve(candidate);
  let existing = resolved;
  let canonical;
  for (;;) {
    try {
      canonical = realpathSync(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      existing = path.dirname(existing);
    }
  }
  if (
    resolved === REPO_ROOT ||
    resolved.startsWith(`${REPO_ROOT}${path.sep}`) ||
    canonical === REPO_ROOT ||
    canonical.startsWith(`${REPO_ROOT}${path.sep}`)
  ) {
    throw new Error("Recovery packets, keys and approvals must stay outside the repository");
  }
  return resolved;
}
function required(flags, name) {
  if (typeof flags[name] !== "string") throw new Error(`--${name} is required`);
  return flags[name];
}
async function pointerReader(flags) {
  await loadEnvFile(
    typeof flags["env-file"] === "string" ? flags["env-file"] : ".env",
    process.env,
  );
  fillDerivedFilebaseToken(process.env);
  if (!process.env.FILEBASE_API_TOKEN)
    throw new Error("Filebase read-only credential is unavailable");
  return () => readIpnsPointer(process.env.FILEBASE_API_TOKEN);
}
async function provenance(candidateCommit, provenanceDigest) {
  return verifyPublicationProvenance({
    repoRoot: REPO_ROOT,
    candidateCommit,
    currentCommit: await currentRepositoryCommit(REPO_ROOT),
    expectedDigest: provenanceDigest,
  });
}

/** Bounded two-host fetch, preserves original bytes and checks actual redirected host. */
async function fetchEvidence(name, artifact, proofs) {
  let original;
  const hosts = new Set();
  for (const gateway of GATEWAYS) {
    const suffix = name === "/" ? "?format=raw" : "";
    const response = await fetch(`${gateway}/ipfs/${artifact.cid}${suffix}`, {
      signal: AbortSignal.timeout(60_000),
      headers: { Accept: name === "/" ? "application/vnd.ipld.raw" : "*/*" },
    });
    if (!response.ok || response.status !== 200)
      throw new Error(`Recovery readback ${name}: HTTP ${response.status}`);
    const final = new URL(response.url);
    if (
      final.protocol !== "https:" ||
      !GATEWAYS.some((base) => new URL(base).host === final.host) ||
      final.pathname !== `/ipfs/${artifact.cid}`
    )
      throw new Error("Recovery gateway redirected outside the approved CID destination");
    const chunks = [];
    let received = 0;
    const maximum = artifact.size ?? 256 * 1024;
    if (maximum > 32 * 1024 * 1024)
      throw new Error("Recovery readback exceeds bounded packet size");
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maximum) throw new Error("Recovery gateway returned oversized bytes");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const sha256 = sha256Digest(bytes);
    if (
      (artifact.size !== undefined && bytes.length !== artifact.size) ||
      (artifact.sha256 !== undefined && sha256 !== artifact.sha256) ||
      (original && !original.equals(bytes))
    ) {
      throw new Error("Recovery gateway byte/digest disagreement");
    }
    original ??= bytes;
    hosts.add(final.host);
    proofs.push({
      name,
      cid: artifact.cid,
      gateway: final.origin,
      fetchedAt: new Date().toISOString(),
      bytes: bytes.length,
      sha256,
    });
  }
  if (hosts.size !== 2) throw new Error("Recovery needs two actually independent gateway hosts");
  return original;
}

export async function runRecoveryCommand(flags) {
  if (["prepare", "sign", "accept"].filter((name) => flags[name] === true).length !== 1) {
    throw new Error("Choose exactly one of --prepare, --sign (human only), or --accept");
  }
  const inputDir = external(required(flags, "input-dir"));
  if (flags.prepare === true) {
    const candidateCommit = required(flags, "candidate-commit");
    const provenanceDigest = required(flags, "provenance-digest");
    await provenance(candidateCommit, provenanceDigest);
    const expected = {
      networkKey: required(flags, "expected-ipns-name"),
      cid: required(flags, "expected-root"),
      sequence: Number(required(flags, "expected-sequence")),
    };
    const readPointer = await pointerReader(flags);
    assertRecoveryPointer(expected, await readPointer());
    const proofs = [];
    const manifestCid = required(flags, "manifest-cid");
    if (!/^b[a-z2-7]{20,}$/.test(manifestCid))
      throw new Error("An exact CIDv1 base32 manifest is required");
    const manifestBytes = await fetchEvidence("manifest", { cid: manifestCid }, proofs);
    const manifest = validateArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
    if (manifest.root.cid !== expected.cid)
      throw new Error("Manifest root does not match the requested observed pointer");
    const entries = ["/", "coverage.json", "query-table.parquet"].map((name) => {
      const entry = manifest.artifacts.find((item) => item.name === name);
      if (!entry) throw new Error(`Producer manifest is missing ${name}`);
      return entry;
    });
    const bodies = [];
    for (const entry of entries) bodies.push(await fetchEvidence(entry.name, entry, proofs));
    const historyBytes = await readFile(HISTORY);
    const history = JSON.parse(historyBytes.toString("utf8"));
    const previous = history.runs
      .filter((run) => run.status === "succeeded")
      .sort((a, b) => a.runId.localeCompare(b.runId))
      .at(-1);
    if (!previous) throw new Error("Last-known successful history is missing");
    const binding = (entry) => ({ cid: entry.cid, size: entry.size, sha256: entry.sha256 });
    // Read again after downloads: mutable pointer drift invalidates the entire preparation.
    assertRecoveryPointer(expected, await readPointer());
    const evidence = {
      schemaVersion: "elephant.observed-predecessor-evidence.v1",
      observedAt: new Date().toISOString(),
      county: "lake",
      bucket: "elephant-oracle-open-data-lake",
      ipnsLabel: "oracle-open-data-lake",
      pointer: expected,
      producerRunId: manifest.runId,
      manifest: {
        cid: manifestCid,
        size: manifestBytes.length,
        sha256: sha256Digest(manifestBytes),
      },
      artifacts: {
        root: binding(entries[0]),
        coverage: binding(entries[1]),
        query: binding(entries[2]),
      },
      lastKnownHistory: {
        runId: previous.runId,
        rootCid: previous.rootCid,
        sha256: sha256Digest(historyBytes),
      },
      disclosure: DISCLOSURE,
      proofs,
      queryReconciliation: null,
    };
    await mkdir(inputDir, { recursive: true, mode: 0o700 });
    const outputs = {
      "producer-manifest.json": manifestBytes,
      "root.block": bodies[0],
      "coverage.json": bodies[1],
      "query-table.parquet": bodies[2],
      "last-known-history.json": historyBytes,
    };
    for (const [name, bytes] of Object.entries(outputs))
      await writeFile(path.join(inputDir, name), bytes, { mode: 0o600, flag: "wx" });
    evidence.queryReconciliation = await readQueryTableCounts(
      path.join(inputDir, "query-table.parquet"),
    );
    await writeFile(
      path.join(inputDir, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const packet = await readRecoveryPacket(inputDir, HISTORY);
    assertRecoveryPointer(expected, await readPointer());
    const target = recoveryTarget(
      packet.evidence,
      packet.evidenceBytes,
      candidateCommit,
      provenanceDigest,
    );
    await writeFile(
      path.join(inputDir, "recovery-request.json"),
      `${JSON.stringify({ schemaVersion: "elephant.predecessor-recovery-request.v1", target }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return { state: "PREPARED_AWAITING_HUMAN_SIGNATURE", target, inputDir, remoteMutations: 0 };
  }
  if (flags.sign === true) {
    const request = JSON.parse(
      await readFile(path.join(inputDir, "recovery-request.json"), "utf8"),
    );
    if (request.schemaVersion !== "elephant.predecessor-recovery-request.v1")
      throw new Error("Unsupported recovery request");
    const packet = await readRecoveryPacket(inputDir, HISTORY);
    const target = recoveryTarget(
      packet.evidence,
      packet.evidenceBytes,
      request.target.candidateCommit,
      request.target.provenanceDigest,
    );
    if (JSON.stringify(request.target) !== JSON.stringify(target))
      throw new Error("Recovery request no longer matches packet");
    await provenance(target.candidateCommit, target.provenanceDigest);
    const payload = buildRecoveryPayload(target, {
      issuedAt: new Date().toISOString(),
      expiresAt: required(flags, "expires-at"),
      approver: required(flags, "approver"),
      nonce: randomBytes(24).toString("base64url"),
    });
    const authorization = signRecoveryAuthorization(
      payload,
      await readFile(external(required(flags, "private-key"))),
    );
    const output = external(required(flags, "output"));
    await writeFile(output, `${JSON.stringify(authorization, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return { state: "HUMAN_SIGNED", output, keyId: authorization.signature.keyId };
  }
  if (flags.accept === true) {
    const authorization = JSON.parse(await readFile(external(required(flags, "approval")), "utf8"));
    await provenance(
      authorization.payload.target.candidateCommit,
      authorization.payload.target.provenanceDigest,
    );
    const receipt = await acceptRecovery({
      inputDir,
      historyPath: HISTORY,
      authorization,
      publicKey: await readFile(external(required(flags, "approval-public-key"))),
      readPointer: await pointerReader(flags),
    });
    return {
      state: receipt.status,
      receiptPath: path.join(inputDir, "recovery-receipt.json"),
      disclosure: receipt.authorization.payload.target.disclosure,
      remoteMutations: 0,
    };
  }
  throw new Error(
    "Choose --prepare, --sign (human only), or --accept; no remote publication action exists here",
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runRecoveryCommand(parseApprovalArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
