#!/usr/bin/env node
/**
 * Regenerate the revisioned PREPARED_LOCAL handoff for one frozen Lake run.
 *
 * The large handoff is evidence, not a second source of truth. This generator
 * carries forward the reviewed source graph from the prior revision, then
 * recomputes every byte digest and reads the exact current publication request
 * and attempt ledger. It never contacts a network service.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runId = "20260911T131000Z";
const previousPath = path.join(
  repositoryRoot,
  "artifacts/orchestration/lake/20260911T131000Z-r001-prepared-local.json",
);
const revisionPath = path.join(
  repositoryRoot,
  "artifacts/orchestration/lake/20260911T131000Z-r002-prepared-local.json",
);
const latestPath = path.join(
  repositoryRoot,
  "artifacts/orchestration/lake/prepared-local.latest.json",
);

const runtimePaths = ["pipeline/package.json", "pipeline/package-lock.json"];
const configPaths = [
  "pipeline/docs/lake-sources.yaml",
  "pipeline/scripts/lake/build-orchestration-manifest.mjs",
  "pipeline/src/counties/lake/enrichment-profile.mjs",
  ".github/workflows/pipeline.yml",
];
const schemaPaths = [
  "pipeline/src/counties/lake/query-table.mjs",
  "pipeline/src/counties/lake/permit-table.mjs",
  `pipeline/data/artifacts/publish/lake/runs/${runId}/schema.json`,
  `pipeline/data/artifacts/publish/lake/runs/${runId}/permit-schema.json`,
];
const provenancePaths = [
  "pipeline/package.json",
  "pipeline/package-lock.json",
  "pipeline/docs/lake-sources.yaml",
  "pipeline/scripts/lake/build-query-table.sql",
  "pipeline/scripts/lake/build-publish-set.mjs",
  "pipeline/scripts/lake/publish-run.mjs",
  "pipeline/src/core/publish-gate.mjs",
  "pipeline/src/core/secondary-pin.mjs",
  "pipeline/src/counties/lake/enrichment-profile.mjs",
  "pipeline/src/counties/lake/query-table.mjs",
  "pipeline/src/counties/lake/permit-table.mjs",
];

/** @param {Buffer | string} bytes */
function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** @param {string} relativePath */
async function component(relativePath) {
  return {
    path: relativePath,
    digest: digest(await readFile(path.join(repositoryRoot, relativePath))),
  };
}

/** @param {string[]} paths */
async function digestGroup(paths) {
  const components = await Promise.all(paths.map(component));
  const records = components
    .map((entry) => `${entry.digest.slice("sha256:".length)}  ${entry.path}\n`)
    .sort()
    .join("");
  return {
    algorithm: "sha256 over sorted '<digest>  <path>\\n' records",
    digest: digest(Buffer.from(records, "utf8")),
    components,
  };
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

const previous = await readJson(path.relative(repositoryRoot, previousPath));
const requestPath = `pipeline/data/artifacts/publish/lake/manifests/${runId}.publication-request.json`;
const request = await readJson(requestPath);
const ledger = await readJson("artifacts/publication-attempts.json");
const attempt = ledger.attempts[request.attemptId];
if (!attempt || attempt.state !== "BUILT" || attempt.authorization !== null) {
  throw new Error(`Expected unapproved BUILT attempt ${request.attemptId}`);
}
if (JSON.stringify(attempt.target) !== JSON.stringify(request.target)) {
  throw new Error("Publication request and ledger target differ");
}

const [runtime, config, schema, provenance] = await Promise.all([
  digestGroup(runtimePaths),
  digestGroup(configPaths),
  digestGroup(schemaPaths),
  digestGroup(provenancePaths),
]);
if (provenance.digest !== request.target.provenanceDigest) {
  throw new Error(
    `Frozen provenance ${request.target.provenanceDigest} does not match current bytes ${provenance.digest}`,
  );
}

const secondaryStage = {
  stage: "independent-secondary-pin",
  state: "NOT_STARTED_UNCONFIGURED",
  remoteSideEffects: false,
};
const stageGraph = previous.stageGraph.filter(
  (stage) => stage.stage !== "independent-secondary-pin",
);
stageGraph.splice(
  stageGraph.findIndex((stage) => stage.stage === "car-upload") + 1,
  0,
  secondaryStage,
);

const secondaryBlocker = {
  id: "independent-secondary-pin",
  severity: "hard-for-publication",
  state: "UNCONFIGURED",
  reason:
    "A live release requires an independent non-Filebase IPFS Pinning Service endpoint and token; no credential was read or provider contacted during local preparation.",
};
const blockers = previous.blockers.filter((blocker) => blocker.id !== secondaryBlocker.id);
blockers.splice(1, 0, secondaryBlocker);

const manifest = {
  ...previous,
  manifestId: `lake:${runId}:prepared-local:r002`,
  revision: 2,
  previousRevision: previous.manifestId,
  updatedAt: attempt.updatedAt,
  operatorIntake: {
    ...previous.operatorIntake,
    notes: [
      ...previous.operatorIntake.notes,
      "The frozen workflow now restores this exact candidate artifact for a separate publish dispatch instead of rebuilding reviewed bytes.",
      "Primary Filebase upload is insufficient: the signed target also requires a successfully reconciled independent secondary pin before public verification.",
    ],
  },
  sourceCatalog: {
    ...previous.sourceCatalog,
    digest: (await component("pipeline/docs/lake-sources.yaml")).digest,
  },
  digests: {
    runtime,
    config,
    schema,
    provenance: {
      algorithm: provenance.algorithm,
      digest: provenance.digest,
      frozenAt: attempt.updatedAt,
      scope: provenancePaths,
    },
  },
  stageGraph,
  publication: {
    ...previous.publication,
    attemptId: request.attemptId,
    attemptState: attempt.state,
    approvalRequest: requestPath,
    requiredActions: request.target.actions,
    independentSecondaryPinRequired: true,
    independentSecondaryPinConfigured: false,
  },
  orchestration: {
    ...previous.orchestration,
    checkpoint: {
      stage: attempt.state,
      sequence: attempt.transitions.length,
      nextAction: "configure-independent-pin-and-await-exact-signed-authorization",
    },
  },
  blockers,
  handoffContract: {
    ...previous.handoffContract,
    instance: {
      ...previous.handoffContract.instance,
      runtimeDigest: runtime.digest,
      configDigest: config.digest,
      schemaDigest: schema.digest,
      provenanceDigest: provenance.digest,
      blockers: blockers.map((blocker) => blocker.id),
      publicationAuthorization: {
        state: "UNAPPROVED",
        required:
          "external exact-target Ed25519 authorization plus independent secondary-pin configuration",
        consumed: false,
      },
    },
  },
  completeness: {
    ...previous.completeness,
    reason:
      "The local candidate is deterministic and schema-gated. Public release remains blocked on full Clermont history, an independent secondary pin, explicit exact-target authorization, and the documented municipal/BBB source limitations.",
  },
};

const body = `${JSON.stringify(manifest, null, 2)}\n`;
await mkdir(path.dirname(revisionPath), { recursive: true });
await writeFile(revisionPath, body, "utf8");
await writeFile(latestPath, body, "utf8");
process.stdout.write(
  `${JSON.stringify({ manifestId: manifest.manifestId, attemptId: request.attemptId, provenanceDigest: provenance.digest })}\n`,
);
