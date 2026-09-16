/** Offline fixtures only: these keys are never an operator/publication trust root. */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildArtifactManifest } from "../src/core/artifact-manifest.mjs";
import { buildUnixfsDirectory, computeUnixfsFileCid } from "../src/core/cid.mjs";
import { sha256Digest } from "../src/core/publish-gate.mjs";
import {
  acceptRecovery,
  assertRecoveryPointer,
  buildRecoveryPayload,
  loadRecoveryAnchor,
  readRecoveryPacket,
  recoveryTarget,
  signRecoveryAuthorization,
  validateRecoveryPacket,
  validateRecoveryHistory,
  verifyRecoveryAuthorization,
} from "../src/core/predecessor-recovery.mjs";
import { assertPublicationPredecessor } from "../scripts/lake/publish-run.mjs";
import { ensureSecondaryPin } from "../src/core/secondary-pin.mjs";
import { appendRun } from "../src/core/run-history.mjs";

const NOW = "2026-09-16T18:00:00.000Z";
const EXPIRES = "2026-09-16T19:00:00.000Z";
const NETWORK_KEY = "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un";
const directories = [];
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const describeBytes = (bytes) => ({
  cid: computeUnixfsFileCid(bytes).cid,
  size: bytes.length,
  sha256: sha256Digest(bytes),
});

async function fixture(
  coverageOverrides = {},
  queryReconciliation = { rows: 1, distinctFolio: 1, nullFolio: 0 },
) {
  const directory = await mkdtemp(path.join(tmpdir(), "oracle-predecessor-test-"));
  directories.push(directory);
  const inputDir = path.join(directory, "private-handoff");
  await mkdir(inputDir, { mode: 0o700 });
  const historyPath = path.join(directory, "run-history.json");
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  // The recovery module checks byte identity, not analytical Parquet contents.
  const queryBytes = Buffer.from("PAR1synthetic-transport-fixturePAR1");
  const coverageBytes = encode({
    runId: "20260911T121542Z",
    county: "lake",
    countyComplete: false,
    tables: { properties: { rows: 1 }, permits: { rows: 2 } },
    ...coverageOverrides,
  });
  const query = describeBytes(queryBytes);
  const coverage = describeBytes(coverageBytes);
  const root = buildUnixfsDirectory([
    { name: "coverage.json", ...computeUnixfsFileCid(coverageBytes) },
    { name: "query-table.parquet", ...computeUnixfsFileCid(queryBytes) },
  ]);
  const rootBytes = Buffer.from(root.bytes);
  const rootArtifact = { cid: root.cid, size: rootBytes.length, sha256: sha256Digest(rootBytes) };
  const manifest = buildArtifactManifest({
    runId: "20260911T121542Z",
    county: "lake",
    generatedAt: NOW,
    rootCid: root.cid,
    rootCarPath: "root.car",
    entries: [
      { name: "/", codec: "directory", ...rootArtifact },
      { name: "coverage.json", codec: "file", ...coverage },
      { name: "query-table.parquet", codec: "file", ...query },
    ],
  });
  const manifestBytes = encode(manifest);
  const oldCid = computeUnixfsFileCid("previous-immutable-snapshot").cid;
  const oldRun = {
    runId: "20260909T180000Z",
    status: "succeeded",
    rootCid: oldCid,
    startedAt: "2026-09-09T18:00:00.000Z",
    finishedAt: "2026-09-09T18:01:00.000Z",
    mode: "full",
    sources: [],
    tables: [{ name: "properties", rows: 1, inserted: 1, updated: 0, unchanged: 0, removed: 0 }],
    limitations: ["Synthetic fixture only; not evidence of operator publication."],
    manifestCid: oldCid,
    carCid: oldCid,
    ipnsName: NETWORK_KEY,
    resolvedCid: oldCid,
    verifiedGateways: [],
  };
  const historyBytes = encode({ schemaVersion: "elephant.run-history.v1", runs: [oldRun] });
  const pointer = { networkKey: NETWORK_KEY, cid: root.cid, sequence: 9 };
  const manifestArtifact = describeBytes(manifestBytes);
  const definitions = [
    ["manifest", manifestArtifact],
    ["/", rootArtifact],
    ["coverage.json", coverage],
    ["query-table.parquet", query],
  ];
  const evidence = {
    schemaVersion: "elephant.observed-predecessor-evidence.v1",
    observedAt: NOW,
    county: "lake",
    bucket: "elephant-oracle-open-data-lake",
    ipnsLabel: "oracle-open-data-lake",
    pointer,
    producerRunId: manifest.runId,
    manifest: manifestArtifact,
    artifacts: { root: rootArtifact, coverage, query },
    queryReconciliation,
    lastKnownHistory: { runId: oldRun.runId, rootCid: oldCid, sha256: sha256Digest(historyBytes) },
    disclosure: {
      originalApproval: "unknown",
      originalSuccessfulPublicationReceipt: "unknown",
      historicalGatewayReadback: "unknown",
    },
    proofs: definitions.flatMap(([name, artifact]) =>
      ["https://ipfs.filebase.io", "https://gw.ipfs-lens.dev"].map((gateway) => ({
        name,
        cid: artifact.cid,
        gateway,
        fetchedAt: NOW,
        bytes: artifact.size,
        sha256: artifact.sha256,
      })),
    ),
  };
  const evidenceBytes = encode(evidence);
  const packet = {
    evidenceBytes,
    manifestBytes,
    rootBytes,
    coverageBytes,
    queryBytes,
    historyBytes,
  };
  await Promise.all(
    Object.entries({
      "evidence.json": evidenceBytes,
      "producer-manifest.json": manifestBytes,
      "root.block": rootBytes,
      "coverage.json": coverageBytes,
      "query-table.parquet": queryBytes,
      "last-known-history.json": historyBytes,
    }).map(([name, bytes]) => writeFile(path.join(inputDir, name), bytes, { mode: 0o600 })),
  );
  await writeFile(historyPath, historyBytes);
  const target = recoveryTarget(
    evidence,
    evidenceBytes,
    "a".repeat(40),
    `sha256:${"b".repeat(64)}`,
  );
  const signed = (overrides = {}) =>
    signRecoveryAuthorization(
      buildRecoveryPayload(target, {
        issuedAt: NOW,
        expiresAt: EXPIRES,
        nonce: "fixture_recovery_nonce_001",
        approver: "fixture-owner@example.test",
        ...overrides,
      }),
      privateKey,
    );
  const authorization = signed();
  const readPointer = vi.fn(async () => globalThis.structuredClone(pointer));
  const accept = (overrides = {}) =>
    acceptRecovery({
      inputDir,
      historyPath,
      authorization,
      publicKey,
      readPointer,
      now: NOW,
      ...overrides,
    });
  return {
    inputDir,
    historyPath,
    privateKey,
    publicKey,
    packet,
    evidence,
    pointer,
    target,
    authorization,
    signed,
    readPointer,
    accept,
    oldRun,
    receiptPath: path.join(inputDir, "recovery-receipt.json"),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("explicit signed external predecessor recovery", () => {
  it.each([false, true])(
    "uses the recovered export's actual business grain when accountTableAvailable=%s",
    async (accountTableAvailable) => {
      const f = await fixture({
        tables: {
          properties: { rows: 1 },
          permits: { rows: 2 },
          businessAccounts: {
            rows: 33346,
            matchedToParcel: 2060,
            accountTableAvailable,
            ...(accountTableAvailable ? { queryableSourceAccounts: 33346 } : {}),
          },
        },
      });
      await f.accept();
      const receiptBytes = await readFile(f.receiptPath);
      const anchor = await loadRecoveryAnchor({
        receiptPath: f.receiptPath,
        publicKey: f.publicKey,
        historyPath: f.historyPath,
        now: NOW,
      });
      expect(anchor.tables.find((table) => table.name === "businessAccounts").rows).toBe(
        accountTableAvailable ? 33346 : 2060,
      );
      expect(await readFile(f.receiptPath)).toEqual(receiptBytes);
      expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
      expect(await readFile(path.join(f.inputDir, "coverage.json"))).toEqual(
        f.packet.coverageBytes,
      );
    },
  );
  it.each(["APPROVAL_CONSUMED", "FINALIZED"])(
    "reloads an exact ledger-authorized succeeded append in a %s resume context",
    async (state) => {
      const f = await fixture();
      await f.accept();
      const receiptBytes = await readFile(f.receiptPath);
      const allowed = {
        ...f.oldRun,
        runId: "20260916T181000Z",
        rootCid: computeUnixfsFileCid("next-successful-snapshot").cid,
        limitations: [`Synthetic ${state} exact durable record`],
      };
      await appendRun(f.historyPath, allowed);
      const appended = await readFile(f.historyPath);
      expect(JSON.parse(appended)).toEqual({
        ...JSON.parse(f.packet.historyBytes),
        runs: [allowed, f.oldRun],
      });
      expect(() => validateRecoveryHistory(f.packet.historyBytes, appended, allowed)).not.toThrow();
      const anchor = await loadRecoveryAnchor({
        receiptPath: f.receiptPath,
        publicKey: f.publicKey,
        historyPath: f.historyPath,
        now: NOW,
        allowedHistoryAppend: allowed,
      });
      expect(anchor.rootCid).toBe(f.pointer.cid);
      expect(await readFile(f.historyPath)).toEqual(appended);
      expect(await readFile(path.join(f.inputDir, "last-known-history.json"))).toEqual(
        f.packet.historyBytes,
      );
      expect(await readFile(f.receiptPath)).toEqual(receiptBytes);
    },
  );

  it("rejects unauthorized appends, wrong records, edited old runs, and unrelated extra history", async () => {
    const f = await fixture();
    await f.accept();
    const allowed = {
      ...f.oldRun,
      runId: "20260916T181000Z",
      rootCid: computeUnixfsFileCid("next-successful-snapshot").cid,
    };
    const live = (runs) => encode({ ...JSON.parse(f.packet.historyBytes), runs });
    const cases = [
      { bytes: live([allowed, f.oldRun]), allowance: null },
      { bytes: live([allowed, f.oldRun]), allowance: { ...allowed, rootCid: f.oldRun.rootCid } },
      {
        bytes: live([allowed, { ...f.oldRun, limitations: ["Edited original record"] }]),
        allowance: allowed,
      },
      {
        bytes: live([{ ...allowed, runId: "20260917T181000Z" }, allowed, f.oldRun]),
        allowance: allowed,
      },
      {
        bytes: live([{ ...allowed, status: "partial" }, f.oldRun]),
        allowance: { ...allowed, status: "partial" },
      },
    ];
    for (const entry of cases) {
      expect(() =>
        validateRecoveryHistory(f.packet.historyBytes, entry.bytes, entry.allowance),
      ).toThrow();
      await writeFile(f.historyPath, entry.bytes);
      await expect(
        loadRecoveryAnchor({
          receiptPath: f.receiptPath,
          publicKey: f.publicKey,
          historyPath: f.historyPath,
          now: NOW,
          allowedHistoryAppend: entry.allowance,
        }),
      ).rejects.toThrow();
      expect(await readFile(path.join(f.inputDir, "last-known-history.json"))).toEqual(
        f.packet.historyBytes,
      );
    }
    await writeFile(f.historyPath, f.packet.historyBytes);
    expect(() =>
      validateRecoveryHistory(f.packet.historyBytes, f.packet.historyBytes),
    ).not.toThrow();
  });
  it("rejects signed handoff reconciliation that disagrees with coverage or folio identity counts", async () => {
    for (const reconciliation of [
      { rows: 2, distinctFolio: 2, nullFolio: 0 },
      { rows: 1, distinctFolio: 2, nullFolio: 0 },
      { rows: 1, distinctFolio: 1, nullFolio: 1 },
    ]) {
      const f = await fixture({}, reconciliation);
      await expect(f.accept()).rejects.toThrow();
      expect(f.readPointer).not.toHaveBeenCalled();
      await expect(stat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
    }
  });
  it("preserves genuinely older coverage bytes without re-dating them as producer-run evidence", async () => {
    const f = await fixture({ runId: "20260910T225242Z" });
    expect(validateRecoveryPacket(f.packet).coverage.runId).toBe("20260910T225242Z");
    await f.accept();
    const anchor = await loadRecoveryAnchor({
      receiptPath: f.receiptPath,
      publicKey: f.publicKey,
      historyPath: f.historyPath,
      now: NOW,
    });
    expect(anchor.runId).toBe("20260911T121542Z");
    expect(await readFile(path.join(f.inputDir, "coverage.json"))).toEqual(f.packet.coverageBytes);
    expect(JSON.parse(await readFile(path.join(f.inputDir, "coverage.json"), "utf8")).runId).toBe(
      "20260910T225242Z",
    );
  });

  it.each([{ county: "other-county" }, { tables: { properties: { rows: -1 } } }])(
    "rejects coherently CID-addressed but invalid coverage metadata %j",
    async (coverage) => {
      const f = await fixture(coverage);
      await expect(f.accept()).rejects.toThrow();
      expect(f.readPointer).not.toHaveBeenCalled();
      await expect(stat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
    },
  );

  it("rejects a corrupted existing receipt acceptance time on idempotent acceptance too", async () => {
    const f = await fixture();
    await f.accept();
    const changed = JSON.parse(await readFile(f.receiptPath, "utf8"));
    changed.acceptedAt = EXPIRES;
    const bytes = encode(changed);
    await writeFile(f.receiptPath, bytes);
    await expect(f.accept()).rejects.toThrow(/acceptance time/);
    expect(await readFile(f.receiptPath)).toEqual(bytes);
    expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
  });

  it("validates actual producer bytes and writes only a private receipt, without fabricating prior success", async () => {
    const f = await fixture();
    expect(validateRecoveryPacket(f.packet).evidence.pointer).toEqual(f.pointer);
    expect((await readRecoveryPacket(f.inputDir, f.historyPath)).manifest.runId).toBe(
      "20260911T121542Z",
    );
    const receipt = await f.accept();
    expect(receipt.status).toBe("externally_observed_recovered");
    expect(
      receipt.authorization.payload.target.disclosure.originalSuccessfulPublicationReceipt,
    ).toBe("unknown");
    expect((await stat(f.receiptPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
    const anchor = await loadRecoveryAnchor({
      receiptPath: f.receiptPath,
      publicKey: f.publicKey,
      historyPath: f.historyPath,
      now: NOW,
    });
    expect(anchor).toMatchObject({
      rootCid: f.pointer.cid,
      runId: "20260911T121542Z",
      pointer: f.pointer,
      tables: [
        { name: "properties", rows: 1 },
        { name: "permits", rows: 2 },
      ],
    });
    expect(anchor.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects missing, bad, and foreign-key signatures before even reading the live pointer", async () => {
    const f = await fixture();
    const unsigned = { payload: f.authorization.payload };
    const corrupted = globalThis.structuredClone(f.authorization);
    corrupted.signature.value = Buffer.alloc(64).toString("base64");
    const foreign = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    await expect(f.accept({ authorization: unsigned })).rejects.toThrow();
    await expect(f.accept({ authorization: corrupted })).rejects.toThrow(/signature/);
    await expect(f.accept({ publicKey: foreign })).rejects.toThrow(/keyId/);
    expect(f.readPointer).not.toHaveBeenCalled();
    await expect(stat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["manifestBytes", "rootBytes", "coverageBytes", "queryBytes", "historyBytes"])(
    "rejects tampered %s without altering original history",
    async (name) => {
      const f = await fixture();
      expect(() =>
        validateRecoveryPacket({
          ...f.packet,
          [name]: Buffer.concat([f.packet[name], Buffer.from("tampered")]),
        }),
      ).toThrow();
      expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
    },
  );

  it("binds the signature to the original evidence bytes, including serialization", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.inputDir, "evidence.json"),
      Buffer.concat([f.packet.evidenceBytes, Buffer.from(" ")]),
    );
    await expect(f.accept()).rejects.toThrow(/exact target/);
    expect(f.readPointer).not.toHaveBeenCalled();
  });

  it.each(["bucket", "ipnsLabel", "manifest", "candidateCommit", "provenanceDigest"])(
    "rejects signed-target %s drift",
    async (name) => {
      const f = await fixture();
      const changed = globalThis.structuredClone(f.target);
      changed[name] =
        name === "manifest"
          ? { ...changed.manifest, sha256: `sha256:${"c".repeat(64)}` }
          : name === "candidateCommit"
            ? "c".repeat(40)
            : name === "provenanceDigest"
              ? `sha256:${"c".repeat(64)}`
              : "different-destination";
      expect(() =>
        verifyRecoveryAuthorization(f.authorization, f.publicKey, changed, NOW),
      ).toThrow();
    },
  );

  it.each(["networkKey", "cid", "sequence"])(
    "rejects live pointer %s drift and writes no receipt",
    async (name) => {
      const f = await fixture();
      const changed = {
        ...f.pointer,
        [name]:
          name === "networkKey"
            ? `k${"a".repeat(50)}`
            : name === "cid"
              ? computeUnixfsFileCid("different-root").cid
              : f.pointer.sequence + 1,
      };
      expect(() => assertRecoveryPointer(f.pointer, changed)).toThrow(/drifted/);
      await expect(f.accept({ readPointer: async () => changed })).rejects.toThrow(/drifted/);
      await expect(stat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects not-yet-active and expired signatures, including exact expiry", async () => {
    const f = await fixture();
    await expect(f.accept({ now: "2026-09-16T17:59:59.999Z" })).rejects.toThrow(/not active/);
    await expect(f.accept({ now: EXPIRES })).rejects.toThrow(/expired/);
    expect(f.readPointer).not.toHaveBeenCalled();
  });

  it("is idempotent for the same authorization but rejects replay/overwrite with a new nonce", async () => {
    const f = await fixture();
    const first = await f.accept();
    const bytes = await readFile(f.receiptPath);
    expect(await f.accept({ now: "2026-09-16T18:01:00.000Z" })).toEqual(first);
    expect(await readFile(f.receiptPath)).toEqual(bytes);
    await expect(
      f.accept({ authorization: f.signed({ nonce: "fixture_recovery_nonce_002" }) }),
    ).rejects.toThrow(/replay\/overwrite/);
    expect(await readFile(f.receiptPath)).toEqual(bytes);
    expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
  });

  it("revalidates the signature and frozen inputs before a recovered anchor can reach publisher mutations", async () => {
    const f = await fixture();
    await f.accept();
    const mutate = vi.fn();
    const publishGuard = async () => {
      const anchor = await loadRecoveryAnchor({
        receiptPath: f.receiptPath,
        publicKey: f.publicKey,
        historyPath: f.historyPath,
        now: NOW,
      });
      mutate(anchor);
    };
    const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
    delete receipt.authorization.signature;
    await writeFile(f.receiptPath, encode(receipt));
    await expect(publishGuard()).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
  });

  it("requires an exact signed receipt digest in the actual publisher predecessor guard", async () => {
    const f = await fixture();
    await f.accept();
    const anchor = await loadRecoveryAnchor({
      receiptPath: f.receiptPath,
      publicKey: f.publicKey,
      historyPath: f.historyPath,
      now: NOW,
    });
    const target = {
      rootCid: computeUnixfsFileCid("next-target").cid,
      ipnsNetworkKey: NETWORK_KEY,
      ipnsPredecessor: { cid: f.pointer.cid, sequence: f.pointer.sequence },
      predecessorRecoveryDigest: anchor.receiptDigest,
    };
    expect(assertPublicationPredecessor(f.oldRun, f.pointer, target, "AUTHORIZED", anchor)).toBe(
      "recorded-predecessor",
    );
    const mutate = vi.fn();
    const guarded = (candidateAnchor, candidateTarget = target, pointer = f.pointer) => {
      assertPublicationPredecessor(
        f.oldRun,
        pointer,
        candidateTarget,
        "AUTHORIZED",
        candidateAnchor,
      );
      mutate();
    };
    expect(() => guarded(null)).toThrow(/verified recovery anchor/);
    expect(() => guarded(anchor, { ...target, predecessorRecoveryDigest: undefined })).toThrow(
      /verified recovery anchor/,
    );
    expect(() => guarded({ ...anchor, receiptDigest: `sha256:${"c".repeat(64)}` })).toThrow(
      /verified recovery anchor/,
    );
    expect(() => guarded({ ...anchor, rootCid: f.oldRun.rootCid })).toThrow(
      /verified recovery anchor/,
    );
    expect(() =>
      guarded({ ...anchor, pointer: { ...anchor.pointer, networkKey: `k${"c".repeat(50)}` } }),
    ).toThrow(/verified recovery anchor/);
    expect(() =>
      guarded({ ...anchor, pointer: { ...anchor.pointer, sequence: anchor.pointer.sequence + 1 } }),
    ).toThrow(/verified recovery anchor/);
    expect(() =>
      guarded(anchor, target, { ...f.pointer, sequence: f.pointer.sequence + 1 }),
    ).toThrow(/live IPNS pointer/);
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
  });

  it("never lends recovered trust to an unrelated later live pointer or an early already-applied target", async () => {
    const f = await fixture();
    await f.accept();
    const anchor = await loadRecoveryAnchor({
      receiptPath: f.receiptPath,
      publicKey: f.publicKey,
      historyPath: f.historyPath,
      now: NOW,
    });
    const target = {
      rootCid: computeUnixfsFileCid("next-target").cid,
      ipnsNetworkKey: NETWORK_KEY,
      ipnsPredecessor: { cid: f.pointer.cid, sequence: f.pointer.sequence },
      predecessorRecoveryDigest: anchor.receiptDigest,
    };
    const applied = { ...f.pointer, cid: target.rootCid, sequence: f.pointer.sequence + 1 };
    expect(() =>
      assertPublicationPredecessor(f.oldRun, applied, target, "AUTHORIZED", anchor),
    ).toThrow(/live IPNS pointer/);
    expect(
      assertPublicationPredecessor(f.oldRun, applied, target, "HISTORY_RECORDED", anchor),
    ).toBe("target-already-applied");
    expect(() =>
      assertPublicationPredecessor(
        f.oldRun,
        { ...applied, cid: computeUnixfsFileCid("unrelated-live-root").cid },
        target,
        "HISTORY_RECORDED",
        anchor,
      ),
    ).toThrow(/live IPNS pointer/);
  });

  it("rejects a changed frozen packet or impossible acceptance time on publisher reload", async () => {
    const f = await fixture();
    await f.accept();
    const reload = () =>
      loadRecoveryAnchor({
        receiptPath: f.receiptPath,
        publicKey: f.publicKey,
        historyPath: f.historyPath,
        now: NOW,
      });
    const receiptBytes = await readFile(f.receiptPath);
    const changedReceipt = JSON.parse(receiptBytes);
    changedReceipt.acceptedAt = EXPIRES;
    await writeFile(f.receiptPath, encode(changedReceipt));
    await expect(reload()).rejects.toThrow(/acceptance time/);
    await writeFile(f.receiptPath, receiptBytes);
    await writeFile(
      path.join(f.inputDir, "coverage.json"),
      Buffer.concat([f.packet.coverageBytes, Buffer.from(" ")]),
    );
    await expect(reload()).rejects.toThrow(/bytes\/digest mismatch/);
    expect(await readFile(f.historyPath)).toEqual(f.packet.historyBytes);
  });
});

describe("asynchronous secondary-pin mutation guard", () => {
  it("awaits a rejecting beforeCreate guard before any mocked POST can happen", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ results: [] }) }));
    let rejectGuard;
    const beforeCreate = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectGuard = reject;
        }),
    );
    const operation = ensureSecondaryPin({
      endpoint: "https://api.pinata.cloud/psa",
      token: "synthetic-fixture-token",
      cid: computeUnixfsFileCid("synthetic-pin").cid,
      name: "fixture-only-pin",
      fetchImpl,
      beforeCreate,
    });
    const rejected = expect(operation).rejects.toThrow("fixture authorization rejected");
    await vi.waitFor(() => expect(beforeCreate).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    rejectGuard(new Error("fixture authorization rejected"));
    await rejected;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });
});
