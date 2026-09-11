import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { validatePublicationLedger } from "../src/core/publish-gate.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const revisionPath = path.join(
  repositoryRoot,
  "artifacts/orchestration/lake/20260911T131000Z-r002-prepared-local.json",
);
const latestPath = path.join(
  repositoryRoot,
  "artifacts/orchestration/lake/prepared-local.latest.json",
);

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function verifyDeclaredDigestGroup(group) {
  const records = [];
  for (const component of group.components) {
    records.push(`${component.digest.slice("sha256:".length)}  ${component.path}\n`);
  }
  records.sort();
  expect(digest(Buffer.from(records.join(""), "utf8"))).toBe(group.digest);
}

async function currentDigestDrift(group) {
  const drift = [];
  for (const component of group.components) {
    const bytes = await readFile(path.join(repositoryRoot, component.path));
    if (digest(bytes) !== component.digest) drift.push(component.path);
  }
  return drift;
}

async function digestPaths(paths) {
  const records = [];
  for (const relativePath of paths) {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    records.push(`${digest(bytes).slice("sha256:".length)}  ${relativePath}\n`);
  }
  records.sort();
  return digest(Buffer.from(records.join(""), "utf8"));
}

describe("revisioned PREPARED_LOCAL Oracle handoff", () => {
  it("is durable, unapproved and explicit about loaded versus published state", async () => {
    const revisionBytes = await readFile(revisionPath);
    const latestBytes = await readFile(latestPath);
    expect(latestBytes.equals(revisionBytes)).toBe(true);
    const manifest = JSON.parse(revisionBytes);

    expect(manifest.schemaVersion).toBe("elephant.oracle-intake-run-manifest.v1");
    expect(manifest.revision).toBe(2);
    expect(manifest.previousRevision).toBe("lake:20260911T131000Z:prepared-local:r001");
    expect(manifest.state).toBe("PREPARED_LOCAL");
    expect(manifest.kit.version).toBe("0.46.1");
    expect(manifest.sourceGraph.nodes.length).toBeGreaterThanOrEqual(9);
    expect(manifest.stageGraph.some((stage) => stage.state === "UNAPPROVED")).toBe(true);
    expect(manifest.publication).toMatchObject({
      approved: false,
      signedAuthorizationPresent: false,
      networkMutationsPerformed: false,
      attemptState: "BUILT",
      independentSecondaryPinRequired: true,
      independentSecondaryPinConfigured: false,
    });
    expect(manifest.publication.requiredActions).toContain("pin-secondary-copy");
    expect(manifest.stageGraph).toContainEqual(
      expect.objectContaining({
        stage: "independent-secondary-pin",
        state: "NOT_STARTED_UNCONFIGURED",
      }),
    );
    expect(manifest.watermarks.loaded.runId).not.toBe(manifest.watermarks.published.runId);
    expect(manifest.watermarks.loadedIsNewerThanPublished).toBe(true);
    expect(manifest.blockers.length).toBeGreaterThan(0);
    expect(manifest.handoffContract.instance.publicationAuthorization.state).toBe("UNAPPROVED");
    expect(manifest.privacy.containsSecrets).toBe(false);
  });

  it("preserves the frozen digest records and detects later release-path drift", async () => {
    const manifest = JSON.parse(await readFile(revisionPath, "utf8"));
    verifyDeclaredDigestGroup(manifest.digests.runtime);
    verifyDeclaredDigestGroup(manifest.digests.config);
    verifyDeclaredDigestGroup(manifest.digests.schema);

    // This manifest belongs to the retired, one-year candidate. The repaired
    // runtime must not be made to look like those reviewed bytes by rewriting
    // its historical digests; a fresh complete candidate is required instead.
    expect(await currentDigestDrift(manifest.digests.runtime)).toContain(
      "pipeline/package.json",
    );
    expect(await currentDigestDrift(manifest.digests.config)).toContain(
      ".github/workflows/pipeline.yml",
    );
    expect(await digestPaths(manifest.digests.provenance.scope)).not.toBe(
      manifest.digests.provenance.digest,
    );
  });

  it("keeps the reusable legacy boolean inactive and validates the active ledger", async () => {
    const retiredGate = JSON.parse(
      await readFile(path.join(repositoryRoot, "artifacts/publish-gate.json"), "utf8"),
    );
    const ledger = JSON.parse(
      await readFile(path.join(repositoryRoot, "artifacts/publication-attempts.json"), "utf8"),
    );
    expect(() => validatePublicationLedger(ledger)).not.toThrow();
    expect(retiredGate).toMatchObject({
      schemaVersion: "elephant.retired-publish-gate.v1",
      active: false,
      replacement: "artifacts/publication-attempts.json",
    });
    const currentAttempt =
      ledger.attempts[JSON.parse(await readFile(revisionPath, "utf8")).publication.attemptId];
    expect(currentAttempt).toMatchObject({
      state: "BUILT",
      authorization: null,
    });
    expect(Object.values(ledger.attempts)).toContainEqual(
      expect.objectContaining({ state: "ROLLED_BACK" }),
    );
    expect(ledger.historicalAttempts).toContainEqual(
      expect.objectContaining({ runId: "20260909T182356Z", disposition: "ROLLED_BACK" }),
    );
  });
});
