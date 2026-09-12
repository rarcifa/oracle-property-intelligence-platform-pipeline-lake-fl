import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  computePublicationProvenance,
  currentRepositoryCommit,
  discoverPublicationProvenanceScope,
  verifyPublicationProvenance,
} from "../scripts/lake/publication-provenance.mjs";
import { publishRun } from "../scripts/lake/publish-run.mjs";

const REPO_ROOT = path.resolve(process.cwd(), "..");
const scratchDirectories = [];
const run = promisify(execFile);

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

async function git(repoRoot, args) {
  const { stdout } = await run("git", args, { cwd: repoRoot, encoding: "utf8" });
  return stdout.trim();
}

async function createCommittedScope(beforeCommit) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "publication-provenance-"));
  scratchDirectories.push(scratch);
  const scope = await discoverPublicationProvenanceScope(REPO_ROOT);
  await Promise.all(
    scope.map(async (logicalPath) => {
      const target = path.join(scratch, logicalPath);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(REPO_ROOT, logicalPath), target);
    }),
  );
  await git(scratch, ["init", "--quiet"]);
  await git(scratch, ["config", "user.name", "rarcifa"]);
  await git(scratch, ["config", "user.email", "ricardo.arcifa@cronoslabs.org"]);
  if (beforeCommit) await beforeCommit(scratch);
  await git(scratch, ["add", "."]);
  await git(scratch, ["commit", "--quiet", "-m", "publication fixture"]);
  return { repoRoot: scratch, candidateCommit: await git(scratch, ["rev-parse", "HEAD"]), scope };
}

describe("publication provenance closure", () => {
  it("binds one clean commit, Node runtime, dependencies, build, and publisher closure", async () => {
    const fixture = await createCommittedScope();
    const first = await computePublicationProvenance(fixture);
    const second = await computePublicationProvenance(fixture);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: "elephant.publication-provenance.v1",
      candidateCommit: fixture.candidateCommit,
      nodeVersion: process.version,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const paths = new Set(first.components.map(({ logicalPath }) => logicalPath));
    for (const required of [
      ".github/workflows/pipeline.yml",
      "pipeline/package.json",
      "pipeline/package-lock.json",
      "pipeline/scripts/lake/build-query-table.sql",
      "pipeline/scripts/lake/build-publish-set.mjs",
      "pipeline/scripts/lake/publish-approve.mjs",
      "pipeline/scripts/lake/publish-run.mjs",
      "pipeline/scripts/lake/publication-provenance.mjs",
      "pipeline/src/core/cid.mjs",
      "pipeline/src/core/car.mjs",
      "pipeline/src/core/artifact-manifest.mjs",
      "pipeline/src/core/gateway-verify.mjs",
      "pipeline/src/core/run-history.mjs",
      "pipeline/src/core/filebase.mjs",
      "pipeline/src/core/publish-gate.mjs",
      "pipeline/src/core/secondary-pin.mjs",
      "pipeline/src/core/coverage-publication.mjs",
      "pipeline/src/core/query-table.mjs",
      "pipeline/src/counties/lake/adapter.mjs",
      "pipeline/src/counties/lake/permit-table.mjs",
    ]) {
      expect(paths, required).toContain(required);
    }
  });

  it("rejects byte drift in every representative publication layer", async () => {
    const fixture = await createCommittedScope();
    const frozen = await computePublicationProvenance(fixture);
    for (const logicalPath of [
      ".github/workflows/pipeline.yml",
      "pipeline/package-lock.json",
      "pipeline/scripts/lake/build-query-table.sql",
      "pipeline/scripts/lake/build-publish-set.mjs",
      "pipeline/scripts/lake/publish-run.mjs",
      "pipeline/src/core/cid.mjs",
      "pipeline/src/core/car.mjs",
      "pipeline/src/core/artifact-manifest.mjs",
      "pipeline/src/core/gateway-verify.mjs",
      "pipeline/src/core/run-history.mjs",
      "pipeline/src/core/filebase.mjs",
      "pipeline/src/core/publish-gate.mjs",
    ]) {
      const target = path.join(fixture.repoRoot, logicalPath);
      const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from("\n// provenance mutation\n")]));
      await expect(
        verifyPublicationProvenance({
          ...fixture,
          currentCommit: fixture.candidateCommit,
          expectedDigest: frozen.digest,
        }),
        logicalPath,
      ).rejects.toThrow(new RegExp(`differs.*${logicalPath.replaceAll("/", "\\/")}`, "i"));
      await writeFile(target, original);
    }
  });

  it("rejects an untracked module imported by committed publisher code", async () => {
    const fixture = await createCommittedScope(async (repoRoot) => {
      const importer = path.join(repoRoot, "pipeline/scripts/lake/publish-run.mjs");
      const source = await readFile(importer, "utf8");
      await writeFile(importer, `${source}\nimport "./untracked-publication-module.mjs";\n`);
    });
    await writeFile(
      path.join(fixture.repoRoot, "pipeline/scripts/lake/untracked-publication-module.mjs"),
      "export const unsafe = true;\n",
    );
    await expect(computePublicationProvenance(fixture)).rejects.toThrow(
      /component is not tracked: pipeline\/scripts\/lake\/untracked-publication-module\.mjs/i,
    );
  });

  it("rejects an indexed component missing from the candidate commit", async () => {
    const fixture = await createCommittedScope(async (repoRoot) => {
      const importer = path.join(repoRoot, "pipeline/scripts/lake/publish-run.mjs");
      const source = await readFile(importer, "utf8");
      await writeFile(importer, `${source}\nimport "./post-commit-publication-module.mjs";\n`);
    });
    const added = path.join(
      fixture.repoRoot,
      "pipeline/scripts/lake/post-commit-publication-module.mjs",
    );
    await writeFile(added, "export const unsafe = true;\n");
    await git(fixture.repoRoot, [
      "add",
      "pipeline/scripts/lake/post-commit-publication-module.mjs",
    ]);
    await expect(computePublicationProvenance(fixture)).rejects.toThrow(
      /has no blob in .*pipeline\/scripts\/lake\/post-commit-publication-module\.mjs/i,
    );
  });

  it("rejects missing, mismatched, and non-Node-22 commit identities", async () => {
    const fixture = await createCommittedScope();
    const frozen = await computePublicationProvenance(fixture);
    await expect(
      computePublicationProvenance({ ...fixture, candidateCommit: "a".repeat(40) }),
    ).rejects.toThrow(/Git check failed|did not resolve/i);
    await expect(
      verifyPublicationProvenance({
        ...fixture,
        currentCommit: "d".repeat(40),
        expectedDigest: frozen.digest,
      }),
    ).rejects.toThrow(/does not match checked-out commit/);
    await expect(
      verifyPublicationProvenance({
        ...fixture,
        currentCommit: fixture.candidateCommit,
        expectedDigest: frozen.digest,
        nodeVersion: "v23.0.0",
      }),
    ).rejects.toThrow(/requires the approved Node 22 runtime/i);
  });

  it("makes publishRun reject provenance before artifacts, approval, credentials, or network", async () => {
    const currentCommit = await currentRepositoryCommit(REPO_ROOT);
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    globalThis.fetch = async () => {
      networkRequests += 1;
      throw new Error("network must remain unreachable");
    };
    try {
      await expect(
        publishRun({
          runId: "missing-publication-run",
          mode: "full",
          candidateWorkflowRunId: "local",
          candidateCommit: currentCommit,
          provenanceDigest: `sha256:${"0".repeat(64)}`,
          expectedIpnsPredecessorCid: "bafybeif7figvhmv7q7ykxxfcs3nbnjutjwistroiqtb433z3uhkmce7jau",
          expectedIpnsPredecessorSequence: 7,
          dryRun: false,
          approvalPath: "/definitely/missing/approval.json",
          approvalPublicKeyPath: "/definitely/missing/public.pem",
          envFile: "/definitely/missing/credentials.env",
        }),
      ).rejects.toThrow(/publication provenance|not tracked|differs/i);
      expect(networkRequests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
