import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { discoverPublicationProvenanceScope } from "../scripts/lake/publication-provenance.mjs";

const REPO_ROOT = path.resolve(process.cwd(), "..");
const run = promisify(execFile);
const scratchDirectories = [];

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

async function git(repoRoot, args) {
  const { stdout } = await run("git", args, { cwd: repoRoot, encoding: "utf8" });
  return stdout.trim();
}

async function cleanPublicationFixture() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "runbook-publication-contract-"));
  scratchDirectories.push(repoRoot);
  for (const logicalPath of await discoverPublicationProvenanceScope(REPO_ROOT)) {
    const destination = path.join(repoRoot, logicalPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(REPO_ROOT, logicalPath), destination);
  }
  await git(repoRoot, ["init", "--quiet"]);
  await git(repoRoot, ["config", "user.name", "rarcifa"]);
  await git(repoRoot, ["config", "user.email", "ricardo.arcifa@cronoslabs.org"]);
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "--quiet", "-m", "runbook fixture"]);
  return repoRoot;
}

describe("runbook publication command contract", () => {
  it("documents the executable helper and every exact-target CLI argument", async () => {
    const runbook = await readFile(path.join(REPO_ROOT, "docs/runbook.md"), "utf8");
    const publication = runbook.slice(
      runbook.indexOf("# 5. Prepare locally"),
      runbook.indexOf("## Two-phase GitHub Actions release"),
    );
    expect(publication).not.toContain("SCOPE=(");
    expect(publication).toContain('COMMIT="$(git -C .. rev-parse HEAD)"');
    expect(publication).toContain("scripts/lake/publication-provenance.mjs");
    expect(publication).toContain('--candidate-commit "$COMMIT"');
    expect(publication.match(/--candidate-commit/g)).toHaveLength(3);
    expect(publication.match(/--expected-ipns-predecessor-cid/g)).toHaveLength(2);
    expect(publication.match(/--expected-ipns-predecessor-sequence/g)).toHaveLength(2);
    expect(publication).toContain("export SECONDARY_PIN_SERVICE_URL=https://api.pinata.cloud/psa");
    expect(publication).toContain('.label == "oracle-open-data-lake"');
    expect(publication).toContain(
      '.network_key == "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un"',
    );
  });

  it("executes the documented COMMIT-to-provenance JSON command in a clean checkout", async () => {
    const repoRoot = await cleanPublicationFixture();
    const shell = String.raw`
      set -euo pipefail
      cd pipeline
      COMMIT="$(git -C .. rev-parse HEAD)"
      PROVENANCE_JSON="$(mktemp)"
      trap 'rm -f "$PROVENANCE_JSON"' EXIT
      node scripts/lake/publication-provenance.mjs \
        --candidate-commit "$COMMIT" > "$PROVENANCE_JSON"
      jq -er --arg commit "$COMMIT" \
        '.candidateCommit == $commit and (.digest | test("^sha256:[a-f0-9]{64}$"))' \
        "$PROVENANCE_JSON"
    `;
    const { stdout } = await run("bash", ["-c", shell], {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    });
    expect(stdout.trim()).toBe("true");
  });
});
