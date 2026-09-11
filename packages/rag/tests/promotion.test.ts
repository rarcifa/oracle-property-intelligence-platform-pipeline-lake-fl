import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validatePublishedRelease } from "../src/promote.js";

const roots: string[] = [];
const runId = "20260911T131000Z";
const rootCid = "bafybeih5xrlpzdvjoky75aq7j2cad36dnnzec4suqiwboy3ucayjgyeqnq";
const manifestCid = "bafkreiaqiwvmkfgz7yziuxeurgb4jpecbzwh57rj3qbzyjszsv2ltuhmwy";
const attemptId = `sha256:${"a".repeat(64)}`;
const names = [
  "coverage.json",
  "index.json",
  "permit-schema.json",
  "schema.json",
  "samples/aged-roofs.json",
  "samples/open-roofing-permits.json",
  "samples/out-of-area-owners.json",
];

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<{
  repoRoot: string;
  latestPath: string;
  manifestPath: string;
  verificationPath: string;
  ledgerPath: string;
}> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "rag-promotion-"));
  roots.push(repoRoot);
  const runDir = path.join(repoRoot, "pipeline/data/artifacts/publish/lake/runs", runId);
  const artifactsDir = path.join(repoRoot, "artifacts");
  await mkdir(path.join(runDir, "samples"), { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  const entries = [];
  for (const [index, name] of names.entries()) {
    const body = `${JSON.stringify({ runId, name })}\n`;
    await writeFile(path.join(runDir, name), body);
    entries.push({
      name,
      cid: `bafkrei${"a".repeat(51)}${"abcdefg"[index]}`,
      size: Buffer.byteLength(body),
      codec: "file",
      sha256: `sha256:${digest(body)}`,
    });
  }
  const manifest = {
    schemaVersion: "elephant.artifact-manifest.v1",
    runId,
    county: "lake",
    generatedAt: "2026-09-11T13:10:00.000Z",
    root: { cid: rootCid, car: `ipfs://${rootCid}?format=car` },
    artifacts: [
      {
        name: "/",
        cid: rootCid,
        size: 1,
        codec: "directory",
        sha256: `sha256:${"b".repeat(64)}`,
      },
      ...entries,
    ],
  };
  const manifestPath = path.join(artifactsDir, `manifest-${runId}.json`);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestBytes);
  const manifestDigest = `sha256:${digest(manifestBytes)}`;
  const verificationArtifacts = [
    ...entries.map(({ name, cid }) => ({ name, cid })),
    { name: "manifest.json", cid: manifestCid },
  ].map((artifact) => ({
    ...artifact,
    verified: true,
    matchedGateways: ["https://ipfs.filebase.io", "https://gw.ipfs-lens.dev"],
  }));
  const latestPath = path.join(artifactsDir, "latest.json");
  await writeFile(
    latestPath,
    `${JSON.stringify({
      runId,
      mode: "full",
      candidateWorkflowRunId: "123456789",
      rootCid,
      manifestCid,
      resolvedCid: rootCid,
      publishedAt: "2026-09-11T14:00:00.000Z",
    })}\n`,
  );
  const verificationPath = path.join(artifactsDir, `verification-${runId}.json`);
  await writeFile(
    verificationPath,
    `${JSON.stringify({
      runId,
      mode: "full",
      candidateWorkflowRunId: "123456789",
      rootCid,
      manifestCid,
      manifestDigest,
      verification: {
        checkedArtifacts: verificationArtifacts.length,
        verifiedArtifacts: verificationArtifacts.length,
        minimumIndependentGateways: 2,
        artifacts: verificationArtifacts,
      },
    })}\n`,
  );
  const ledgerPath = path.join(artifactsDir, "publication-attempts.json");
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      attempts: {
        [attemptId]: {
          state: "FINALIZED",
          target: {
            runId,
            rootCid,
            manifestDigest,
            mode: "full",
            candidateWorkflowRunId: "123456789",
          },
          transitions: [{ stage: "FINALIZED", receipt: { rootCid } }],
        },
      },
    })}\n`,
  );
  return { repoRoot, latestPath, manifestPath, verificationPath, ledgerPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("published RAG promotion", () => {
  it("constructs a receipt only from one exact FINALIZED run and verified manifest", async () => {
    const paths = await fixture();
    const result = await validatePublishedRelease({ ...paths, runId, rootCid });
    expect(result.promotionReceipt).toMatchObject({
      runId,
      rootCid,
      manifestCid,
      publicationAttemptId: attemptId,
      publicationState: "FINALIZED",
      mode: "full",
      candidateWorkflowRunId: "123456789",
    });
    expect(result.promotionReceipt.evidence.map(({ role }) => role).sort()).toEqual(
      ["latest", "manifest", "publication-ledger", "verification"].sort(),
    );
    expect(result.corpusSource).toMatchObject({
      runId,
      rootCid,
      releaseState: "published",
      releaseReceipt: "packages/rag/promotion-receipt.json",
    });
    expect(result.corpusSource.artifacts.map(({ name }) => name)).toEqual(names);
  });

  it("rejects workflow identity drift and incomplete gateway coverage", async () => {
    const paths = await fixture();
    const latest = JSON.parse(await readFile(paths.latestPath, "utf8"));
    latest.candidateWorkflowRunId = "999999999";
    await writeFile(paths.latestPath, `${JSON.stringify(latest)}\n`);
    await expect(validatePublishedRelease({ ...paths, runId, rootCid })).rejects.toThrow(
      /do not share one release identity/,
    );

    const complete = await fixture();
    const verification = JSON.parse(await readFile(complete.verificationPath, "utf8"));
    verification.verification.artifacts.pop();
    verification.verification.checkedArtifacts -= 1;
    verification.verification.verifiedArtifacts -= 1;
    await writeFile(complete.verificationPath, `${JSON.stringify(verification)}\n`);
    await expect(validatePublishedRelease({ ...complete, runId, rootCid })).rejects.toThrow(
      /whole manifest/,
    );
  });

  it("rejects a non-finalized ledger and local artifact drift", async () => {
    const paths = await fixture();
    const ledger = JSON.parse(await readFile(paths.ledgerPath, "utf8"));
    ledger.attempts[attemptId].state = "IPNS_VERIFIED";
    await writeFile(paths.ledgerPath, `${JSON.stringify(ledger)}\n`);
    await expect(validatePublishedRelease({ ...paths, runId, rootCid })).rejects.toThrow(
      /FINALIZED/,
    );

    const changed = await fixture();
    await writeFile(
      path.join(
        changed.repoRoot,
        "pipeline/data/artifacts/publish/lake/runs",
        runId,
        "coverage.json",
      ),
      "tampered\n",
    );
    await expect(validatePublishedRelease({ ...changed, runId, rootCid })).rejects.toThrow(
      /does not match the finalized manifest/,
    );
  });
});
