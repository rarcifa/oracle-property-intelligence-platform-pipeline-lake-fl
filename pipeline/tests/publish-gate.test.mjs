import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseApprovalArgs, runApprovalCommand } from "../scripts/lake/publish-approve.mjs";
import {
  assertSecondaryPinRuntimeTarget,
  loadLivePublicationCapabilities,
  mayAttemptLivePublication,
} from "../scripts/lake/publish-run.mjs";
import {
  REQUIRED_PUBLISH_ACTIONS,
  advancePublicationAttempt,
  assertPublicationAuthorizationActive,
  authorizePublicationAttempt,
  beginPublicationAttempt,
  buildPublishAuthorizationPayload,
  consumePublicationAuthorization,
  nextPublicationRecoveryAction,
  publicationAttemptId,
  readPublicationLedger,
  recordVerifiedIpnsReadback,
  rollBackUnapprovedPublicationAttempt,
  signPublishAuthorization,
  verifyPublishAuthorization,
} from "../src/core/publish-gate.mjs";

const directories = [];
const NOW = "2026-09-11T12:00:00.000Z";
const LATER = "2026-09-11T13:00:00.000Z";
const EXPIRED = "2026-09-11T11:00:00.000Z";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function target(runId = "20260911T120000Z", rootSuffix = "a") {
  const rootCid = `bafybeigpkklcelrvukkwvor42wfmibmvwuveufwjspsumgmpbx3r26iowy${rootSuffix}`;
  return {
    county: "lake",
    runId,
    mode: "full",
    candidateWorkflowRunId: "123456789",
    candidateCommit: "5".repeat(40),
    rootCid,
    manifestDigest: `sha256:${"1".repeat(64)}`,
    provenanceDigest: `sha256:${"2".repeat(64)}`,
    bucket: "elephant-oracle-open-data-lake",
    primaryCars: {
      root: {
        key: `runs/${runId}/root.car`,
        bytes: 123,
        sha256: `sha256:${"3".repeat(64)}`,
        cid: rootCid,
      },
      manifest: {
        key: `runs/${runId}/manifest.car`,
        bytes: 45,
        sha256: `sha256:${"4".repeat(64)}`,
        cid: `bafkreigpkklcelrvukkwvor42wfmibmvwuveufwjspsumgmpbx3r26iowy${rootSuffix}`,
      },
    },
    secondaryPin: {
      provider: "pinata",
      apiBase: "https://api.pinata.cloud/psa",
      apiOrigin: "https://api.pinata.cloud",
      apiPath: "/psa/pins",
      rootPinName: `oracle-open-data-lake/${runId}/root`,
      manifestPinName: `oracle-open-data-lake/${runId}/manifest`,
    },
    ipnsLabel: "oracle-open-data-lake",
    ipnsNetworkKey: "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un",
    ipnsPredecessor: {
      cid: "bafybeif7figvhmv7q7ykxxfcs3nbnjutjwistroiqtb433z3uhkmce7jau",
      sequence: 7,
    },
    actions: [...REQUIRED_PUBLISH_ACTIONS],
  };
}

function approval(exactTarget, keyPair, overrides = {}) {
  return signPublishAuthorization(
    buildPublishAuthorizationPayload(exactTarget, {
      issuedAt: NOW,
      expiresAt: LATER,
      nonce: "nQ2K5oaPJ9qkq2g1R6v0kH8Z",
      approver: "release-owner@example.com",
      ...overrides,
    }),
    keyPair.privateKey,
  );
}

function verificationReceipt() {
  const artifacts = ["manifest.json", "query-table.parquet", "shard-0000.json"].map((name) => ({
    name,
    verified: true,
    matchedGateways: ["https://ipfs.filebase.io", "https://gw.ipfs-lens.dev"],
    results: [],
  }));
  return {
    checkedArtifacts: artifacts.length,
    verifiedArtifacts: artifacts.length,
    minimumIndependentGateways: 2,
    artifacts,
  };
}

async function scratchLedger() {
  const directory = await mkdtemp(path.join(tmpdir(), "oracle-publication-ledger-"));
  directories.push(directory);
  return path.join(directory, "publication-attempts.json");
}

async function prepare(ledgerPath, exactTarget) {
  const attempt = await beginPublicationAttempt(ledgerPath, exactTarget, { at: NOW });
  await advancePublicationAttempt(
    ledgerPath,
    attempt.attemptId,
    "FROZEN",
    { root: exactTarget.rootCid },
    { at: NOW },
  );
  await advancePublicationAttempt(
    ledgerPath,
    attempt.attemptId,
    "BUILT",
    { manifest: exactTarget.manifestDigest },
    { at: NOW },
  );
  return attempt.attemptId;
}

async function driveAfterAuthorization(ledgerPath, attemptId, exactTarget) {
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "ROOT_UPLOAD_RECORDED",
    { cid: exactTarget.rootCid },
    { at: NOW },
  );
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "MANIFEST_UPLOAD_RECORDED",
    { digest: exactTarget.manifestDigest },
    { at: NOW },
  );
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "SECONDARY_PIN_RECORDED",
    { independent: true },
    { at: NOW },
  );
  await advancePublicationAttempt(ledgerPath, attemptId, "VERIFIED", verificationReceipt(), {
    at: NOW,
  });
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "HISTORY_RECORDED",
    { immutable: true },
    { at: NOW },
  );
  await advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "IPNS_REPOINT_RECORDED",
    { cid: exactTarget.rootCid },
    { at: NOW },
  );
  await recordVerifiedIpnsReadback(
    ledgerPath,
    attemptId,
    {
      networkKey: exactTarget.ipnsNetworkKey,
      cid: exactTarget.rootCid,
      sequence: exactTarget.ipnsPredecessor.sequence + 1,
    },
    { at: NOW },
  );
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("exact-target Ed25519 authorization", () => {
  it("does not let credentials override a schedule or explicit dry-run", () => {
    process.env.S3_ACCESS_KEY_ID = "present-but-not-authority";
    process.env.S3_SECRET_ACCESS_KEY = "present-but-not-authority";
    expect(
      mayAttemptLivePublication({
        dryRun: false,
        approvalPath: null,
        approvalPublicKeyPath: null,
      }),
    ).toBe(false);
    expect(
      mayAttemptLivePublication({
        dryRun: true,
        approvalPath: "/outside/signed.json",
        approvalPublicKeyPath: "/outside/public.pem",
      }),
    ).toBe(false);
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });

  it("rejects Pinata host/path normalization tricks before reading a capability file", async () => {
    const exactTarget = target();
    for (const endpoint of [
      "https://api.pinata.cloud/psa/",
      "https://API.pinata.cloud/psa",
      "https://api.pinata.cloud/psa?redirect=1",
      "https://api.pinata.cloud/psa#pins",
      "https://api.pinata.cloud/psa/../psa",
      "https://api.pinata.cloud/%70sa",
      "https://api.pinata.cloud/psa/pins",
      "https://api.pinata.cloud@evil.example/psa",
    ]) {
      let fileReads = 0;
      await expect(
        loadLivePublicationCapabilities({
          target: exactTarget,
          endpoint,
          envFile: "/must-not-be-read.env",
          environment: { SECONDARY_PIN_SERVICE_URL: endpoint },
          loadEnvironmentFile: async () => {
            fileReads += 1;
          },
        }),
      ).rejects.toThrow(/must exactly equal signed|signed Pinata origin\/path/);
      expect(fileReads, endpoint).toBe(0);
    }

    for (const candidate of [
      { ...exactTarget, secondaryPin: { ...exactTarget.secondaryPin, provider: "other" } },
      {
        ...exactTarget,
        secondaryPin: { ...exactTarget.secondaryPin, rootPinName: "wrong/root" },
      },
      {
        ...exactTarget,
        secondaryPin: { ...exactTarget.secondaryPin, manifestPinName: "wrong/manifest" },
      },
    ]) {
      let fileReads = 0;
      await expect(
        loadLivePublicationCapabilities({
          target: candidate,
          endpoint: exactTarget.secondaryPin.apiBase,
          envFile: "/must-not-be-read.env",
          environment: { SECONDARY_PIN_SERVICE_URL: exactTarget.secondaryPin.apiBase },
          loadEnvironmentFile: async () => {
            fileReads += 1;
          },
        }),
      ).rejects.toThrow(/Invalid publication target/);
      expect(fileReads).toBe(0);
    }
  });

  it("loads tokens only after exact Pinata target comparison and rejects env-file drift", async () => {
    const exactTarget = target();
    let fileReads = 0;
    const environment = {
      SECONDARY_PIN_SERVICE_URL: exactTarget.secondaryPin.apiBase,
    };
    const capabilities = await loadLivePublicationCapabilities({
      target: exactTarget,
      endpoint: environment.SECONDARY_PIN_SERVICE_URL,
      envFile: "/external/capabilities.env",
      environment,
      loadEnvironmentFile: async (_path, env) => {
        fileReads += 1;
        env.S3_ACCESS_KEY_ID = "filebase-access";
        env.S3_SECRET_ACCESS_KEY = "filebase-secret";
        env.SECONDARY_PIN_SERVICE_TOKEN = "scoped-pinata-jwt";
      },
    });
    expect(fileReads).toBe(1);
    expect(capabilities.secondaryPinEndpoint).toBe("https://api.pinata.cloud/psa");
    expect(capabilities.secondaryPinToken).toBe("scoped-pinata-jwt");

    let driftFileReads = 0;
    const drifted = {
      SECONDARY_PIN_SERVICE_URL: exactTarget.secondaryPin.apiBase,
    };
    await expect(
      loadLivePublicationCapabilities({
        target: exactTarget,
        endpoint: drifted.SECONDARY_PIN_SERVICE_URL,
        envFile: "/external/capabilities.env",
        environment: drifted,
        loadEnvironmentFile: async (_path, env) => {
          driftFileReads += 1;
          env.SECONDARY_PIN_SERVICE_URL = "https://evil.example/psa";
        },
      }),
    ).rejects.toThrow(/must exactly equal signed/);
    expect(driftFileReads).toBe(1);
  });

  it("does not let approval for candidate A publish candidate B", () => {
    const keyPair = keys();
    const candidateA = target("20260911T120000Z", "a");
    const candidateB = target("20260911T120001Z", "b");
    const signed = approval(candidateA, keyPair);
    expect(() =>
      verifyPublishAuthorization(signed, keyPair.publicKey, candidateB, { now: NOW }),
    ).toThrow(/exact target/);
  });

  it("binds commit, workflow, CARs, Pinata target, pin names, and IPNS predecessor", () => {
    const keyPair = keys();
    const exactTarget = target();
    const signed = approval(exactTarget, keyPair);
    expect(() =>
      verifyPublishAuthorization(
        signed,
        keyPair.publicKey,
        { ...exactTarget, mode: "incremental" },
        { now: NOW },
      ),
    ).toThrow(/exact target/);
    expect(() =>
      verifyPublishAuthorization(
        signed,
        keyPair.publicKey,
        { ...exactTarget, candidateCommit: "6".repeat(40) },
        { now: NOW },
      ),
    ).toThrow(/exact target/);
    expect(() =>
      verifyPublishAuthorization(
        signed,
        keyPair.publicKey,
        {
          ...exactTarget,
          primaryCars: {
            ...exactTarget.primaryCars,
            root: { ...exactTarget.primaryCars.root, key: `runs/${exactTarget.runId}/other.car` },
          },
        },
        { now: NOW },
      ),
    ).toThrow(/exact target|immutable run-specific/);
    expect(() =>
      verifyPublishAuthorization(
        signed,
        keyPair.publicKey,
        { ...exactTarget, candidateWorkflowRunId: "987654321" },
        { now: NOW },
      ),
    ).toThrow(/exact target/);
    for (const secondaryPin of [
      { ...exactTarget.secondaryPin, provider: "other" },
      { ...exactTarget.secondaryPin, apiBase: "https://evil.example/psa" },
      { ...exactTarget.secondaryPin, apiOrigin: "https://evil.example" },
      { ...exactTarget.secondaryPin, apiPath: "/pinning/pinJSONToIPFS" },
      { ...exactTarget.secondaryPin, rootPinName: "different/root" },
      { ...exactTarget.secondaryPin, manifestPinName: "different/manifest" },
    ]) {
      expect(() =>
        verifyPublishAuthorization(
          signed,
          keyPair.publicKey,
          { ...exactTarget, secondaryPin },
          { now: NOW },
        ),
      ).toThrow(/exact target|Invalid publication target/);
    }
    expect(() =>
      verifyPublishAuthorization(
        signed,
        keyPair.publicKey,
        {
          ...exactTarget,
          ipnsPredecessor: { ...exactTarget.ipnsPredecessor, sequence: 8 },
        },
        { now: NOW },
      ),
    ).toThrow(/exact target/);
    expect(() =>
      verifyPublishAuthorization(
        signed,
        keyPair.publicKey,
        {
          ...exactTarget,
          ipnsPredecessor: {
            ...exactTarget.ipnsPredecessor,
            cid: "bafybeidifferentpredecessorcid5555555555555555555555555",
          },
        },
        { now: NOW },
      ),
    ).toThrow(/exact target/);
  });

  it("will not authorize a pre-identity attempt preserved only for audit", async () => {
    const ledgerPath = await scratchLedger();
    const keyPair = keys();
    const current = target();
    const legacy = { ...current };
    delete legacy.mode;
    delete legacy.candidateWorkflowRunId;
    delete legacy.candidateCommit;
    delete legacy.primaryCars;
    delete legacy.secondaryPin;
    delete legacy.ipnsPredecessor;
    const attemptId = `sha256:${createHash("sha256").update(canonicalJson(legacy)).digest("hex")}`;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        ledgerPath,
        `${JSON.stringify({
          schemaVersion: "elephant.publication-attempt-ledger.v1",
          revision: 1,
          attempts: {
            [attemptId]: {
              attemptId,
              target: legacy,
              state: "BUILT",
              createdAt: NOW,
              updatedAt: NOW,
              authorization: null,
              transitions: [
                { sequence: 1, stage: "PREPARED", at: NOW, receipt: {} },
                { sequence: 2, stage: "FROZEN", at: NOW, receipt: {} },
                { sequence: 3, stage: "BUILT", at: NOW, receipt: {} },
              ],
            },
          },
          consumedApprovals: [],
          historicalAttempts: [],
        })}\n`,
      ),
    );
    await expect(
      authorizePublicationAttempt(
        ledgerPath,
        attemptId,
        approval(current, keyPair),
        keyPair.publicKey,
        { now: NOW, at: NOW },
      ),
    ).rejects.toThrow(/predates the current signed commit\/provider\/predecessor contract/);
  });

  it("rejects expiry and a forged signature", () => {
    const keyPair = keys();
    const exactTarget = target();
    const signed = approval(exactTarget, keyPair, {
      expiresAt: EXPIRED,
      issuedAt: "2026-09-11T10:00:00.000Z",
    });
    expect(() =>
      verifyPublishAuthorization(signed, keyPair.publicKey, exactTarget, { now: NOW }),
    ).toThrow(/expired/);
    const forged = {
      ...approval(exactTarget, keyPair),
      signature: {
        ...approval(exactTarget, keyPair).signature,
        value: Buffer.alloc(64).toString("base64"),
      },
    };
    expect(() =>
      verifyPublishAuthorization(forged, keyPair.publicKey, exactTarget, { now: NOW }),
    ).toThrow(/verification failed/);
  });

  it("blocks a new side effect when an authorization expires after verification", async () => {
    const ledgerPath = await scratchLedger();
    const exactTarget = target();
    const keyPair = keys();
    const attemptId = await prepare(ledgerPath, exactTarget);
    const authorized = await authorizePublicationAttempt(
      ledgerPath,
      attemptId,
      approval(exactTarget, keyPair),
      keyPair.publicKey,
      { now: NOW, at: NOW },
    );
    expect(() => assertPublicationAuthorizationActive(authorized, LATER)).toThrow(/expired/);
  });

  it("treats possession of the signing key—not a claimed --by name—as authority", async () => {
    const flags = parseApprovalArgs(["--by", "Release Owner", "--note", "trust me"]);
    await expect(runApprovalCommand(flags)).rejects.toThrow(/usage:/);
  });
});

describe("transactional publication ledger", () => {
  it("can retire a superseded local candidate but never an authorized attempt", async () => {
    const ledgerPath = await scratchLedger();
    const exactTarget = target();
    const attemptId = await prepare(ledgerPath, exactTarget);
    const reason = "formatter changed the frozen provenance before any network action";
    const rolledBack = await rollBackUnapprovedPublicationAttempt(ledgerPath, attemptId, reason, {
      at: NOW,
    });
    expect(rolledBack.state).toBe("ROLLED_BACK");
    await expect(
      rollBackUnapprovedPublicationAttempt(ledgerPath, attemptId, "different", {
        at: NOW,
      }),
    ).rejects.toThrow(/different evidence/);

    const authorizedLedger = await scratchLedger();
    const authorizedAttemptId = await prepare(authorizedLedger, exactTarget);
    const keyPair = keys();
    await authorizePublicationAttempt(
      authorizedLedger,
      authorizedAttemptId,
      approval(exactTarget, keyPair),
      keyPair.publicKey,
      { now: NOW, at: NOW },
    );
    await expect(
      rollBackUnapprovedPublicationAttempt(authorizedLedger, authorizedAttemptId, reason, {
        at: NOW,
      }),
    ).rejects.toThrow(/must be recovered/);
  });

  it("consumes a successful release once and rejects replay", async () => {
    const ledgerPath = await scratchLedger();
    const exactTarget = target();
    const keyPair = keys();
    const signed = approval(exactTarget, keyPair);
    const attemptId = await prepare(ledgerPath, exactTarget);
    await authorizePublicationAttempt(ledgerPath, attemptId, signed, keyPair.publicKey, {
      now: NOW,
      at: NOW,
    });
    await driveAfterAuthorization(ledgerPath, attemptId, exactTarget);
    await consumePublicationAuthorization(ledgerPath, attemptId, { at: NOW });
    await advancePublicationAttempt(
      ledgerPath,
      attemptId,
      "FINALIZED",
      { complete: true },
      { at: NOW },
    );

    const ledger = await readPublicationLedger(ledgerPath);
    expect(ledger.attempts[attemptId].state).toBe("FINALIZED");
    expect(ledger.consumedApprovals).toEqual([
      { nonce: signed.payload.nonce, attemptId, consumedAt: NOW },
    ]);
    await expect(
      authorizePublicationAttempt(ledgerPath, attemptId, signed, keyPair.publicKey, {
        now: NOW,
        at: NOW,
      }),
    ).rejects.toThrow(/already consumed/);
  });

  it("fails closed on null, stale-CID, and wrong-name IPNS readback", async () => {
    const cases = [
      null,
      {
        networkKey: target().ipnsNetworkKey,
        cid: target("20260911T120001Z", "b").rootCid,
        sequence: target().ipnsPredecessor.sequence + 1,
      },
      {
        networkKey: "k51qzi5uqu5differentnetworkkey000000000000",
        cid: target().rootCid,
        sequence: target().ipnsPredecessor.sequence + 1,
      },
      {
        networkKey: target().ipnsNetworkKey,
        cid: target().rootCid,
        sequence: target().ipnsPredecessor.sequence + 2,
      },
    ];
    for (const readback of cases) {
      const ledgerPath = await scratchLedger();
      const exactTarget = target();
      const keyPair = keys();
      const attemptId = await prepare(ledgerPath, exactTarget);
      await authorizePublicationAttempt(
        ledgerPath,
        attemptId,
        approval(exactTarget, keyPair),
        keyPair.publicKey,
        { now: NOW, at: NOW },
      );
      await advancePublicationAttempt(
        ledgerPath,
        attemptId,
        "ROOT_UPLOAD_RECORDED",
        {},
        { at: NOW },
      );
      await advancePublicationAttempt(
        ledgerPath,
        attemptId,
        "MANIFEST_UPLOAD_RECORDED",
        {},
        { at: NOW },
      );
      await advancePublicationAttempt(
        ledgerPath,
        attemptId,
        "SECONDARY_PIN_RECORDED",
        { independent: true },
        { at: NOW },
      );
      await advancePublicationAttempt(ledgerPath, attemptId, "VERIFIED", verificationReceipt(), {
        at: NOW,
      });
      await advancePublicationAttempt(ledgerPath, attemptId, "HISTORY_RECORDED", {}, { at: NOW });
      await advancePublicationAttempt(
        ledgerPath,
        attemptId,
        "IPNS_REPOINT_RECORDED",
        {},
        { at: NOW },
      );
      await expect(
        recordVerifiedIpnsReadback(ledgerPath, attemptId, readback, { at: NOW }),
      ).rejects.toThrow(/missing or does not match/);
    }
  });

  it("will not record partial or one-gateway verification", async () => {
    const ledgerPath = await scratchLedger();
    const exactTarget = target();
    const keyPair = keys();
    const attemptId = await prepare(ledgerPath, exactTarget);
    await authorizePublicationAttempt(
      ledgerPath,
      attemptId,
      approval(exactTarget, keyPair),
      keyPair.publicKey,
      { now: NOW, at: NOW },
    );
    await advancePublicationAttempt(ledgerPath, attemptId, "ROOT_UPLOAD_RECORDED", {}, { at: NOW });
    await advancePublicationAttempt(
      ledgerPath,
      attemptId,
      "MANIFEST_UPLOAD_RECORDED",
      {},
      { at: NOW },
    );
    await advancePublicationAttempt(
      ledgerPath,
      attemptId,
      "SECONDARY_PIN_RECORDED",
      { independent: true },
      { at: NOW },
    );
    await expect(
      advancePublicationAttempt(
        ledgerPath,
        attemptId,
        "VERIFIED",
        {
          checkedArtifacts: 1,
          verifiedArtifacts: 1,
          minimumIndependentGateways: 1,
          artifacts: [{ verified: true, matchedGateways: ["https://ipfs.filebase.io"] }],
        },
        { at: NOW },
      ),
    ).rejects.toThrow();
    await expect(
      advancePublicationAttempt(
        ledgerPath,
        attemptId,
        "VERIFIED",
        {
          checkedArtifacts: 1,
          verifiedArtifacts: 1,
          minimumIndependentGateways: 2,
          artifacts: [
            {
              verified: true,
              matchedGateways: ["https://same.example/ipfs", "https://same.example/another-path"],
            },
          ],
        },
        { at: NOW },
      ),
    ).rejects.toThrow(/independent gateway hosts/);
  });

  it("recovers after every transition without a duplicate or missing attempt", async () => {
    const crashStates = [
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
    ];
    for (const [caseIndex, crashState] of crashStates.entries()) {
      const ledgerPath = await scratchLedger();
      const exactTarget = target(
        `20260911T12${String(caseIndex).padStart(2, "0")}00Z`,
        String.fromCharCode(97 + caseIndex),
      );
      const keyPair = keys();
      const signed = approval(exactTarget, keyPair, {
        nonce: `recoveryNonce000000000${caseIndex}`,
      });
      const attemptId = publicationAttemptId(exactTarget);
      await beginPublicationAttempt(ledgerPath, exactTarget, { at: NOW });
      const transitions = [
        ["FROZEN", { root: exactTarget.rootCid }],
        ["BUILT", { manifest: exactTarget.manifestDigest }],
      ];
      for (const [stage, receipt] of transitions) {
        if ((await readPublicationLedger(ledgerPath)).attempts[attemptId].state === crashState)
          break;
        await advancePublicationAttempt(ledgerPath, attemptId, stage, receipt, { at: NOW });
      }
      if (
        (await readPublicationLedger(ledgerPath)).attempts[attemptId].state !== crashState &&
        crashStates.indexOf(crashState) >= 3
      ) {
        await authorizePublicationAttempt(ledgerPath, attemptId, signed, keyPair.publicKey, {
          now: NOW,
          at: NOW,
        });
      }
      const remaining = [
        ["ROOT_UPLOAD_RECORDED", { cid: exactTarget.rootCid }],
        ["MANIFEST_UPLOAD_RECORDED", { digest: exactTarget.manifestDigest }],
        ["SECONDARY_PIN_RECORDED", { independent: true }],
        ["VERIFIED", verificationReceipt()],
        ["HISTORY_RECORDED", { immutable: true }],
        ["IPNS_REPOINT_RECORDED", { cid: exactTarget.rootCid }],
      ];
      for (const [stage, receipt] of remaining) {
        const current = (await readPublicationLedger(ledgerPath)).attempts[attemptId];
        if (current.state === crashState) break;
        if (current.state === stage) continue;
        const desired = [
          "ROOT_UPLOAD_RECORDED",
          "MANIFEST_UPLOAD_RECORDED",
          "SECONDARY_PIN_RECORDED",
          "VERIFIED",
          "HISTORY_RECORDED",
          "IPNS_REPOINT_RECORDED",
        ].indexOf(stage);
        const currentDesired = [
          "AUTHORIZED",
          "ROOT_UPLOAD_RECORDED",
          "MANIFEST_UPLOAD_RECORDED",
          "SECONDARY_PIN_RECORDED",
          "VERIFIED",
          "HISTORY_RECORDED",
          "IPNS_REPOINT_RECORDED",
        ].indexOf(current.state);
        if (currentDesired === desired)
          await advancePublicationAttempt(ledgerPath, attemptId, stage, receipt, { at: NOW });
      }

      // Simulate restart: reload durable bytes, then resume by next-action state.
      let current = (await readPublicationLedger(ledgerPath)).attempts[attemptId];
      expect(Object.keys((await readPublicationLedger(ledgerPath)).attempts)).toEqual([attemptId]);
      if (current.state === "PREPARED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "FROZEN",
          { root: exactTarget.rootCid },
          { at: NOW },
        );
      if (current.state === "FROZEN")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "BUILT",
          { manifest: exactTarget.manifestDigest },
          { at: NOW },
        );
      if (current.state === "BUILT")
        current = await authorizePublicationAttempt(
          ledgerPath,
          attemptId,
          signed,
          keyPair.publicKey,
          { now: NOW, at: NOW },
        );
      if (current.state === "AUTHORIZED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "ROOT_UPLOAD_RECORDED",
          { cid: exactTarget.rootCid },
          { at: NOW },
        );
      if (current.state === "ROOT_UPLOAD_RECORDED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "MANIFEST_UPLOAD_RECORDED",
          { digest: exactTarget.manifestDigest },
          { at: NOW },
        );
      if (current.state === "MANIFEST_UPLOAD_RECORDED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "SECONDARY_PIN_RECORDED",
          { independent: true },
          { at: NOW },
        );
      if (current.state === "SECONDARY_PIN_RECORDED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "VERIFIED",
          verificationReceipt(),
          { at: NOW },
        );
      if (current.state === "VERIFIED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "HISTORY_RECORDED",
          { immutable: true },
          { at: NOW },
        );
      if (current.state === "HISTORY_RECORDED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "IPNS_REPOINT_RECORDED",
          { cid: exactTarget.rootCid },
          { at: NOW },
        );
      if (current.state === "IPNS_REPOINT_RECORDED")
        current = await recordVerifiedIpnsReadback(
          ledgerPath,
          attemptId,
          {
            networkKey: exactTarget.ipnsNetworkKey,
            cid: exactTarget.rootCid,
            sequence: exactTarget.ipnsPredecessor.sequence + 1,
          },
          { at: NOW },
        );
      if (current.state === "IPNS_VERIFIED")
        current = await consumePublicationAuthorization(ledgerPath, attemptId, { at: NOW });
      if (current.state === "APPROVAL_CONSUMED")
        current = await advancePublicationAttempt(
          ledgerPath,
          attemptId,
          "FINALIZED",
          { complete: true },
          { at: NOW },
        );
      expect(current.state).toBe("FINALIZED");
      expect(nextPublicationRecoveryAction(current)).toBe("none");
      const persisted = JSON.parse(await readFile(ledgerPath, "utf8"));
      expect(Object.keys(persisted.attempts)).toEqual([attemptId]);
      expect(
        new Set(persisted.attempts[attemptId].transitions.map((entry) => entry.stage)).size,
      ).toBe(persisted.attempts[attemptId].transitions.length);
    }
  });
});
