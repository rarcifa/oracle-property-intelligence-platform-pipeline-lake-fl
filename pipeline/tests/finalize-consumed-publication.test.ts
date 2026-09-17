import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRawCid } from "../src/core/cid.mjs";
import { finalizeConsumedPublication } from "../src/core/finalize-consumed-publication.ts";
import { parseLocalFinalizationArgs } from "../scripts/lake/finalize-consumed-publication.ts";
import { readCurrentRowHashes } from "../scripts/lake/publish-run.mjs";
import {
  REQUIRED_PUBLISH_ACTIONS,
  advancePublicationAttempt,
  authorizePublicationAttempt,
  beginPublicationAttempt,
  buildHumanPublishApproval,
  consumePublicationAuthorization,
  readPublicationLedger,
  recordVerifiedIpnsReadback,
  sha256Digest,
} from "../src/core/publish-gate.mjs";
import { appendRun, readRunHistory, RUN_HISTORY_SCHEMA_VERSION } from "../src/core/run-history.mjs";

const directories: string[] = [];
const NOW = "2026-09-17T17:00:00.000Z";
const FINISHED = "2026-09-17T17:01:00.000Z";
const EXPIRED_NOW = "2026-09-18T17:00:00.000Z";
const COMMIT = "4fc47a475bd01d483b81150b741914eec2f8bc32";
const gateways = ["https://first.example", "https://second.example"];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(stage = "APPROVAL_CONSUMED") {
  const root = await mkdtemp(path.join(tmpdir(), "oracle-local-finalize-"));
  directories.push(root);
  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts);
  const runId = "20260916T181000Z";
  const queryPath = path.join(
    root,
    "pipeline/data/artifacts/publish/lake/runs",
    runId,
    "query-table.parquet",
  );
  await mkdir(path.dirname(queryPath), { recursive: true });
  const query = Buffer.from("test-query-bytes");
  await writeFile(queryPath, query);
  const rootBytes = Buffer.from("root-dag");
  const car = Buffer.from("snapshot-car");
  const rootCid = computeRawCid(rootBytes);
  const carCid = computeRawCid(car);
  const manifest = {
    schemaVersion: "elephant.artifact-manifest.v1",
    runId,
    county: "lake",
    generatedAt: NOW,
    root: { cid: rootCid, car: `ipfs://${carCid}` },
    artifacts: [
      {
        name: "/",
        cid: rootCid,
        size: rootBytes.length,
        sha256: sha256Digest(rootBytes),
        codec: "directory",
      },
      {
        name: "query-table.parquet",
        cid: computeRawCid(query),
        size: query.length,
        sha256: sha256Digest(query),
        codec: "file",
      },
      {
        name: "snapshot.car",
        cid: carCid,
        size: car.length,
        sha256: sha256Digest(car),
        codec: "file",
      },
    ],
    directoryCars: [{ directoryCid: rootCid, carCid }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestCid = computeRawCid(manifestBytes);
  await writeFile(path.join(artifacts, `manifest-${runId}.json`), manifestBytes);
  const target = {
    county: "lake",
    runId,
    mode: "full",
    candidateWorkflowRunId: "local",
    candidateCommit: COMMIT,
    rootCid,
    manifestDigest: sha256Digest(manifestBytes),
    provenanceDigest: `sha256:${"2".repeat(64)}`,
    bucket: "elephant-oracle-open-data-lake",
    primaryCars: {
      root: {
        key: `runs/${runId}/root.car`,
        cid: rootCid,
        bytes: rootBytes.length,
        sha256: sha256Digest(rootBytes),
      },
      manifest: {
        key: `runs/${runId}/manifest.car`,
        cid: manifestCid,
        bytes: manifestBytes.length,
        sha256: sha256Digest(manifestBytes),
      },
      archive: {
        key: `runs/${runId}/archive.car`,
        cid: carCid,
        bytes: car.length,
        sha256: sha256Digest(car),
      },
    },
    secondaryPin: {
      provider: "pinata",
      apiBase: "https://api.pinata.cloud/psa",
      apiOrigin: "https://api.pinata.cloud",
      apiPath: "/psa/pins",
      rootPinName: `oracle-open-data-lake/${runId}/root`,
      manifestPinName: `oracle-open-data-lake/${runId}/manifest`,
      archivePinName: `oracle-open-data-lake/${runId}/archive`,
    },
    ipnsLabel: "oracle-open-data-lake",
    ipnsNetworkKey: "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un",
    ipnsPredecessor: { cid: computeRawCid("old-root"), sequence: 13 },
    actions: [...REQUIRED_PUBLISH_ACTIONS],
  };
  const authorization = buildHumanPublishApproval(target, {
    approvedBy: "rarcifa",
    approvedAt: NOW,
    expiresAt: "2026-09-17T18:00:00.000Z",
    nonce: "local_finalizer_test_nonce_123",
    approvalSource: "owner-conversation",
  });
  const ledgerPath = path.join(artifacts, "publication-attempts.json");
  const attempt = await beginPublicationAttempt(ledgerPath, target, { at: NOW });
  const attemptId: string = attempt.attemptId;
  for (const next of ["FROZEN", "BUILT"])
    await advancePublicationAttempt(ledgerPath, attemptId, next, {}, { at: NOW });
  await authorizePublicationAttempt(ledgerPath, attemptId, authorization, Buffer.alloc(0), {
    at: NOW,
    now: NOW,
  });
  for (const next of ["ROOT_UPLOAD_RECORDED", "MANIFEST_UPLOAD_RECORDED"])
    await advancePublicationAttempt(ledgerPath, attemptId, next, {}, { at: NOW });
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "SECONDARY_PIN_RECORDED",
    {
      root: { cid: rootCid, status: "pinned" },
      manifest: { cid: manifestCid, status: "pinned" },
      archive: { cid: carCid, status: "pinned" },
    },
    { at: NOW },
  );
  const objects = [
    {
      name: "manifest.json",
      cid: manifestCid,
      size: manifestBytes.length,
      sha256: target.manifestDigest,
    },
    ...manifest.artifacts,
  ];
  const verification = {
    checkedArtifacts: objects.length,
    verifiedArtifacts: objects.length,
    minimumIndependentGateways: 2,
    artifacts: objects.map((object) => ({
      name: object.name,
      cid: object.cid,
      verified: true,
      matchedGateways: gateways,
      results: gateways.map((gateway) => ({
        gateway,
        ok: true,
        status: 200,
        bytes: object.size,
        sha256: object.sha256,
        error: null,
        responseUrl: `${gateway}/ipfs/${object.cid}`,
      })),
    })),
  };
  await advancePublicationAttempt(ledgerPath, attemptId, "VERIFIED", verification, { at: NOW });
  const record = {
    runId,
    candidateWorkflowRunId: "local",
    candidateCommit: COMMIT,
    startedAt: NOW,
    finishedAt: FINISHED,
    mode: "full",
    sources: [],
    tables: [
      {
        name: "properties",
        rows: 1,
        basis: "row-hash",
        inserted: 1,
        updated: 0,
        unchanged: 0,
        removed: 0,
      },
    ],
    limitations: ["Source-only; current-open semantics are unknown."],
    rootCid,
    manifestCid,
    carCid,
    ipnsName: target.ipnsNetworkKey,
    resolvedCid: rootCid,
    verifiedGateways: gateways,
    status: "succeeded",
  };
  const evidence = {
    runId,
    mode: target.mode,
    candidateWorkflowRunId: "local",
    candidateCommit: COMMIT,
    rootCid,
    manifestCid,
    manifestDigest: target.manifestDigest,
    verification,
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  const evidencePath = path.join(artifacts, `verification-${runId}.json`);
  await writeFile(evidencePath, evidenceBytes);
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "HISTORY_RECORDED",
    {
      runRecord: record,
      verificationEvidence: `artifacts/verification-${runId}.json`,
      verificationDigest: sha256Digest(evidenceBytes),
    },
    { at: FINISHED },
  );
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "IPNS_REPOINT_RECORDED",
    { cid: rootCid },
    { at: FINISHED },
  );
  const pointer = { networkKey: target.ipnsNetworkKey, cid: rootCid, sequence: 14 };
  await recordVerifiedIpnsReadback(ledgerPath, attemptId, pointer, { at: FINISHED });
  if (stage === "APPROVAL_CONSUMED")
    await consumePublicationAuthorization(ledgerPath, attemptId, { at: FINISHED });
  const historyPath = path.join(artifacts, "run-history.json");
  await writeFile(
    historyPath,
    JSON.stringify({ schemaVersion: RUN_HISTORY_SCHEMA_VERSION, runs: [] }),
  );
  const readPointer = vi.fn(async () => pointer);
  const readHashes = vi.fn(async () => new Map([["canonical-parcel", "a".repeat(32)]]));
  const options = {
    repoRoot: root,
    attemptId,
    authorization,
    expectedCandidateCommit: COMMIT,
    readPointer,
    readHashes,
    now: EXPIRED_NOW,
  };
  return {
    root,
    artifacts,
    options,
    ledgerPath,
    historyPath,
    evidencePath,
    queryPath,
    record,
    target,
    verification,
    evidence,
    pointer,
  };
}

async function localFiles(f: Awaited<ReturnType<typeof fixture>>) {
  const result: Record<string, string | null> = {};
  for (const name of [
    "publication-attempts.json",
    "run-history.json",
    "row-hashes.json",
    "latest.json",
  ]) {
    try {
      result[name] = await readFile(path.join(f.artifacts, name), "utf8");
    } catch {
      result[name] = null;
    }
  }
  return result;
}

describe("consumed publication local finalization", () => {
  it("repairs exact durable history after approval expiry, preserves all twelve transitions, and is idempotent", async () => {
    const f = await fixture();
    const prior = Object.values((await readPublicationLedger(f.ledgerPath)).attempts).find(
      (attempt) => attempt.attemptId === f.options.attemptId,
    );
    const result = await finalizeConsumedPublication(f.options);
    expect(result.repaired).toBe(true);
    expect(result.attempt.state).toBe("FINALIZED");
    expect(result.attempt.transitions).toHaveLength(13);
    expect(result.attempt.transitions.slice(0, 12)).toEqual(prior!.transitions);
    expect(result.attempt.target).toEqual(prior!.target);
    expect((await readRunHistory(f.historyPath)).runs).toEqual([f.record]);
    expect(JSON.parse((await localFiles(f))["latest.json"]!).candidateCommit).toBe(COMMIT);
    const written = await localFiles(f);
    expect((await finalizeConsumedPublication(f.options)).repaired).toBe(false);
    expect(await localFiles(f)).toEqual(written);
    expect(f.options.readPointer).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate an already appended matching durable record after an interruption", async () => {
    const f = await fixture();
    await appendRun(f.historyPath, f.record);
    await finalizeConsumedPublication(f.options);
    expect((await readRunHistory(f.historyPath)).runs).toHaveLength(1);
  });

  it.each([
    "before-consumption",
    "wrong-commit",
    "wrong-approval",
    "evidence-bytes",
    "manifest-bytes",
    "query-bytes",
    "row-hashes",
    "pointer-root",
    "pointer-sequence",
    "history-conflict",
    "newer-latest",
  ] as const)("refuses %s without any local receipt mutation", async (failure) => {
    const f = await fixture(failure === "before-consumption" ? "IPNS_VERIFIED" : undefined);
    if (failure === "wrong-commit") f.options.expectedCandidateCommit = "9".repeat(40);
    if (failure === "wrong-approval")
      f.options.authorization = { ...f.options.authorization, approvedBy: "someone-else" };
    if (failure === "evidence-bytes") await writeFile(f.evidencePath, "{}");
    if (failure === "manifest-bytes")
      await writeFile(path.join(f.artifacts, `manifest-${f.record.runId}.json`), "{}");
    if (failure === "query-bytes") await writeFile(f.queryPath, "changed");
    if (failure === "row-hashes") f.options.readHashes.mockResolvedValue(new Map());
    if (failure === "pointer-root")
      f.options.readPointer.mockResolvedValue({ ...f.pointer, cid: computeRawCid("wrong-root") });
    if (failure === "pointer-sequence")
      f.options.readPointer.mockResolvedValue({ ...f.pointer, sequence: 15 });
    if (failure === "history-conflict")
      await appendRun(f.historyPath, {
        ...f.record,
        limitations: ["conflicting immutable evidence"],
      });
    if (failure === "newer-latest")
      await writeFile(
        path.join(f.artifacts, "latest.json"),
        JSON.stringify({ runId: "newer-run", publishedAt: EXPIRED_NOW }),
      );
    const before = await localFiles(f);
    await expect(finalizeConsumedPublication(f.options)).rejects.toThrow();
    expect(await localFiles(f)).toEqual(before);
  });

  it.each([
    "gateway-digest",
    "duplicate-host",
    "redirect",
    "missing-object",
    "wrong-durable-root",
    "secondary-cid",
  ] as const)("refuses bound but invalid %s evidence before writing", async (failure) => {
    const f = await fixture();
    const ledger = JSON.parse(await readFile(f.ledgerPath, "utf8"));
    const attempt = ledger.attempts[f.options.attemptId];
    const evidence = structuredClone(f.evidence);
    if (failure === "gateway-digest")
      evidence.verification.artifacts[0]!.results[0]!.sha256 = `sha256:${"9".repeat(64)}`;
    if (failure === "duplicate-host") {
      for (const proof of evidence.verification.artifacts) {
        proof.results[1]!.gateway = `${gateways[0]}:443`;
        proof.results[1]!.responseUrl = `${gateways[0]}:443/ipfs/${proof.cid}`;
        proof.matchedGateways[1] = `${gateways[0]}:443`;
      }
    }
    if (failure === "redirect")
      evidence.verification.artifacts[0]!.results[0]!.responseUrl = `https://other.example/ipfs/${f.record.manifestCid}`;
    if (failure === "missing-object") evidence.verification.artifacts.pop();
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(f.evidencePath, bytes);
    attempt.transitions.find(
      (transition: { stage: string }) => transition.stage === "HISTORY_RECORDED",
    ).receipt.verificationDigest = sha256Digest(bytes);
    attempt.transitions.find(
      (transition: { stage: string }) => transition.stage === "VERIFIED",
    ).receipt = evidence.verification;
    if (failure === "wrong-durable-root")
      attempt.transitions.find(
        (transition: { stage: string }) => transition.stage === "HISTORY_RECORDED",
      ).receipt.runRecord.rootCid = computeRawCid("wrong-root");
    if (failure === "secondary-cid")
      attempt.transitions.find(
        (transition: { stage: string }) => transition.stage === "SECONDARY_PIN_RECORDED",
      ).receipt.root.cid = computeRawCid("wrong-secondary");
    await writeFile(f.ledgerPath, JSON.stringify(ledger));
    const before = await localFiles(f);
    await expect(finalizeConsumedPublication(f.options)).rejects.toThrow();
    expect(await localFiles(f)).toEqual(before);
  });

  it("refuses FINALIZED records with missing history rather than inventing a prior completed receipt", async () => {
    const f = await fixture();
    await finalizeConsumedPublication(f.options);
    await writeFile(
      f.historyPath,
      JSON.stringify({ schemaVersion: RUN_HISTORY_SCHEMA_VERSION, runs: [] }),
    );
    await expect(finalizeConsumedPublication(f.options)).rejects.toThrow(
      /missing its immutable history/,
    );
  });
});

describe("local-only recovery CLI", () => {
  it("rejects remote effect and signing flags, duplicate flags, and missing explicit identity", () => {
    const valid = [
      "--attempt-id",
      "sha256:abc",
      "--approval",
      "/external/approval.json",
      "--expected-candidate-commit",
      COMMIT,
    ];
    expect(parseLocalFinalizationArgs(valid)["expected-candidate-commit"]).toBe(COMMIT);
    for (const flag of [
      "--publish",
      "--pin",
      "--repoint-ipns",
      "--private-key",
      "--sign",
      "--new-approval",
    ])
      expect(() => parseLocalFinalizationArgs([...valid, flag, "yes"])).toThrow();
    expect(() => parseLocalFinalizationArgs([...valid, "--attempt-id", "duplicate"])).toThrow();
    expect(() => parseLocalFinalizationArgs([])).toThrow(/Missing/);
  });
});

describe("canonical row-hash cache primitive", () => {
  it("reads actual DuckDB CSV columns without introducing quote characters into IDs or hashes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oracle-row-hash-"));
    directories.push(directory);
    const parquet = path.join(directory, "query-table.parquet");
    await promisify(execFile)("duckdb", [
      "-c",
      `COPY (SELECT '01-17-27-0001-000-00100' AS request_identifier, 12 AS assessed_value, 2 AS permit_count, NULL AS open_permit_count, 16 AS roof_age_years, 'A' AS owner_name, '2026-01-01' AS latest_permit_date) TO '${parquet}' (FORMAT PARQUET);`,
    ]);
    expect(await readCurrentRowHashes(parquet)).toEqual(
      new Map([
        [
          "01-17-27-0001-000-00100",
          createHash("md5").update("12|2||16|A|2026-01-01").digest("hex"),
        ],
      ]),
    );
  });
});
