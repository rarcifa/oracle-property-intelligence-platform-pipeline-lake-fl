#!/usr/bin/env node
/**
 * Re-verify a published run's artifacts across EVERY known gateway.
 *
 * The kit's verifier stops as soon as enough independent gateways agree, which
 * is the right default — continuing spends minutes re-downloading the same bytes
 * without changing whether the run passes. But it means the recorded evidence
 * names only the two gateways that happened to answer first, so
 * `latest.json.verifiedGateways` under-reported what is actually retrievable and
 * read as though the data were reachable from one vendor plus one other host.
 *
 * This sweeps the full list for the evidence record. The pass criterion is
 * unchanged: `verified` still means at least two independent gateways returned
 * bytes matching the manifest's length and digest. A gateway that rate-limits or
 * truncates is recorded as a failure rather than dropped, because "this gateway
 * did not serve it" is itself evidence.
 *
 * The kit is not modified: the threshold is a parameter, and it is raised here
 * only to defeat the early exit.
 *
 * Usage: node scripts/reverify-across-gateways.mjs [--run-id <id>]
 *
 * @module scripts/reverify-across-gateways
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GATEWAYS,
  verifyArtifactAcrossGateways,
} from "../.claude/skills/use-oracle/runtime/src/core/gateway-verify.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = path.join(REPO_ROOT, "artifacts");

/** Independent gateways required for a pass. Unchanged from the kit default. */
const REQUIRED_INDEPENDENT_GATEWAYS = 2;

/**
 * @param {string} message - Event name.
 * @param {Record<string, unknown>} [fields] - Extra fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event: message, ...fields })}\n`);
}

const runIdFlag = process.argv.indexOf("--run-id");
const latest = JSON.parse(readFileSync(path.join(ARTIFACTS, "latest.json"), "utf8"));
const runId = runIdFlag === -1 ? String(latest.runId) : String(process.argv[runIdFlag + 1]);

const manifestPath = path.join(ARTIFACTS, `manifest-${runId}.json`);
const evidencePath = path.join(ARTIFACTS, `verification-${runId}.json`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const previous = JSON.parse(readFileSync(evidencePath, "utf8"));

// Re-check exactly what was checked before, so the record stays comparable
// rather than quietly changing scope.
const names = new Set(previous.verifications.map((entry) => entry.name));
const manifestBytes = readFileSync(manifestPath);
const entries = [
  ...(names.has("manifest.json")
    ? [
        {
          name: "manifest.json",
          cid: String(latest.manifestCid),
          size: previous.verifications.find((entry) => entry.name === "manifest.json").results[0]
            .bytes,
          sha256: previous.verifications.find((entry) => entry.name === "manifest.json").results[0]
            .sha256,
        },
      ]
    : []),
  ...manifest.artifacts.filter((entry) => entry.codec === "file" && names.has(entry.name)),
];

log("reverify_start", {
  runId,
  artifacts: entries.length,
  gateways: DEFAULT_GATEWAYS.length,
  manifestBytes: manifestBytes.length,
});

const verifications = [];
for (const entry of entries) {
  const result = await verifyArtifactAcrossGateways({
    cid: entry.cid,
    expectedSize: entry.size,
    expectedSha256: entry.sha256,
    gateways: [...DEFAULT_GATEWAYS],
    // Raised only to defeat the early exit, so every gateway is asked.
    minimumIndependentGateways: DEFAULT_GATEWAYS.length,
  });

  const matchedHosts = new Set(
    result.results.filter((one) => one.ok).map((one) => new URL(one.gateway).host),
  );
  verifications.push({
    name: entry.name,
    ...result,
    // Restore the real pass criterion: the sweep was for evidence, not a
    // stricter bar. Claiming a run failed because a rate-limiting gateway did
    // not answer would be false.
    verified: matchedHosts.size >= REQUIRED_INDEPENDENT_GATEWAYS,
    minimumIndependentGateways: REQUIRED_INDEPENDENT_GATEWAYS,
  });
  log("artifact_verified", {
    name: entry.name,
    verified: matchedHosts.size >= REQUIRED_INDEPENDENT_GATEWAYS,
    matched: [...matchedHosts],
    asked: result.results.length,
  });
}

const verifiedGateways = [
  ...new Set(
    verifications.flatMap((entry) =>
      entry.results.filter((one) => one.ok).map((one) => one.gateway),
    ),
  ),
];

if (verifications.some((entry) => !entry.verified)) {
  throw new Error(
    `Refusing to write: ${verifications.filter((entry) => !entry.verified).length} artifact(s) no longer verify`,
  );
}

writeFileSync(
  evidencePath,
  `${JSON.stringify({ runId, rootCid: manifest.root.cid, verifications }, null, 2)}\n`,
);
writeFileSync(
  path.join(ARTIFACTS, "latest.json"),
  `${JSON.stringify({ ...latest, verifiedGateways }, null, 2)}\n`,
);

log("reverify_complete", { runId, verifiedGateways, artifacts: verifications.length });
