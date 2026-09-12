#!/usr/bin/env node
/**
 * Close the publication trust boundary over the exact candidate commit,
 * runtime, dependency lock, workflow, build inputs, and every local module
 * reachable from the publisher. A reviewed artifact is publishable only by
 * the same source tree that produced it.
 *
 * @module scripts/lake/publication-provenance
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const PUBLICATION_PROVENANCE_SCHEMA_VERSION = "elephant.publication-provenance.v1";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..", "..");
const run = promisify(execFile);

// These are roots, not a hand-maintained approximation of the closure. Local
// imports are followed recursively below. Explicit roots retain non-JS build
// inputs and every named publication primitive even when a future refactor
// temporarily stops importing one from publish-run.
export const PUBLICATION_PROVENANCE_ROOTS = Object.freeze([
  ".github/workflows/pipeline.yml",
  "pipeline/package.json",
  "pipeline/package-lock.json",
  "pipeline/scripts/lake/build-query-table.sql",
  "pipeline/scripts/lake/build-publish-set.mjs",
  "pipeline/scripts/lake/publish-approve.mjs",
  "pipeline/scripts/lake/publish-run.mjs",
  "pipeline/scripts/lake/publication-provenance.mjs",
  "pipeline/src/core/artifact-manifest.mjs",
  "pipeline/src/core/car.mjs",
  "pipeline/src/core/cid.mjs",
  "pipeline/src/core/filebase.mjs",
  "pipeline/src/core/gateway-verify.mjs",
  "pipeline/src/core/publish-gate.mjs",
  "pipeline/src/core/run-history.mjs",
  "pipeline/src/core/secondary-pin.mjs",
]);

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function gitText(repoRoot, args) {
  try {
    const { stdout } = await run("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`Publication provenance Git check failed (${args.join(" ")}): ${detail}`);
  }
}

async function gitBytes(repoRoot, args) {
  try {
    const { stdout } = await run("git", args, {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
    });
    return Buffer.from(stdout);
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`Publication provenance Git blob check failed (${args.join(" ")}): ${detail}`);
  }
}

async function assertCandidateCommit(repoRoot, candidateCommit) {
  if (!COMMIT_PATTERN.test(candidateCommit)) {
    throw new Error("Publication candidate commit must be an exact 40-character Git SHA");
  }
  const resolved = (
    await gitText(repoRoot, ["rev-parse", "--verify", `${candidateCommit}^{commit}`])
  )
    .trim()
    .toLowerCase();
  if (resolved !== candidateCommit) {
    throw new Error(`Publication candidate SHA ${candidateCommit} did not resolve exactly`);
  }
  const currentCommit = (await gitText(repoRoot, ["rev-parse", "HEAD"])).trim().toLowerCase();
  if (currentCommit !== candidateCommit) {
    throw new Error(
      `Publication candidate commit ${candidateCommit} does not match checked-out commit ${currentCommit}`,
    );
  }
  return currentCommit;
}

async function committedComponent(repoRoot, candidateCommit, logicalPath) {
  try {
    await gitText(repoRoot, ["ls-files", "--error-unmatch", "--", logicalPath]);
  } catch {
    throw new Error(`Publication provenance component is not tracked: ${logicalPath}`);
  }
  let committedBytes;
  try {
    committedBytes = await gitBytes(repoRoot, [
      "show",
      "--no-textconv",
      `${candidateCommit}:${logicalPath}`,
    ]);
  } catch {
    throw new Error(
      `Publication provenance component has no blob in ${candidateCommit}: ${logicalPath}`,
    );
  }
  const workingBytes = await readFile(path.join(repoRoot, logicalPath));
  if (!workingBytes.equals(committedBytes)) {
    throw new Error(
      `Publication provenance component differs from ${candidateCommit}: ${logicalPath}`,
    );
  }
  return {
    logicalPath,
    bytes: committedBytes.length,
    sha256: sha256(committedBytes),
  };
}

function localImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith(".")) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

async function resolveLocalImport(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.json`]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Publication provenance cannot resolve ${specifier} from ${importer}`);
}

/**
 * Discover the deterministic local transitive closure from the declared roots.
 *
 * @param {string} repoRoot - Repository root.
 * @returns {Promise<string[]>} Sorted repository-relative paths.
 */
export async function discoverPublicationProvenanceScope(repoRoot = DEFAULT_REPO_ROOT) {
  const absoluteRoot = path.resolve(repoRoot);
  const pending = PUBLICATION_PROVENANCE_ROOTS.map((entry) => path.join(absoluteRoot, entry));
  const visited = new Set();
  while (pending.length > 0) {
    const current = path.resolve(pending.pop());
    if (visited.has(current)) continue;
    if (current !== absoluteRoot && !current.startsWith(`${absoluteRoot}${path.sep}`)) {
      throw new Error(`Publication provenance escaped the repository: ${current}`);
    }
    const bytes = await readFile(current);
    visited.add(current);
    if (!/\.(?:mjs|js|ts)$/.test(current)) continue;
    for (const specifier of localImportSpecifiers(bytes.toString("utf8"))) {
      pending.push(await resolveLocalImport(current, specifier));
    }
  }
  return [...visited]
    .map((entry) => path.relative(absoluteRoot, entry).split(path.sep).join("/"))
    .sort();
}

/**
 * @param {{repoRoot?: string, candidateCommit: string, nodeVersion?: string}} options
 */
export async function computePublicationProvenance({
  repoRoot = DEFAULT_REPO_ROOT,
  candidateCommit,
  nodeVersion = process.version,
}) {
  if (!/^v22\./.test(nodeVersion)) {
    throw new Error(`Publication requires the approved Node 22 runtime, received ${nodeVersion}`);
  }
  await assertCandidateCommit(repoRoot, candidateCommit);
  const scope = await discoverPublicationProvenanceScope(repoRoot);
  const components = [];
  for (const logicalPath of scope) {
    components.push(await committedComponent(repoRoot, candidateCommit, logicalPath));
  }
  const body = {
    schemaVersion: PUBLICATION_PROVENANCE_SCHEMA_VERSION,
    candidateCommit,
    nodeVersion,
    components,
  };
  return { ...body, digest: `sha256:${sha256(Buffer.from(canonicalJson(body), "utf8"))}` };
}

/**
 * Recompute and prove the exact reviewed source closure before any credential
 * file is read or publication network client is constructed.
 *
 * @param {{repoRoot?: string, candidateCommit: string, currentCommit: string, expectedDigest: string, nodeVersion?: string}} options
 */
export async function verifyPublicationProvenance({
  repoRoot = DEFAULT_REPO_ROOT,
  candidateCommit,
  currentCommit,
  expectedDigest,
  nodeVersion = process.version,
}) {
  if (!DIGEST_PATTERN.test(expectedDigest)) {
    throw new Error("A frozen sha256 publication provenance digest is required");
  }
  if (!COMMIT_PATTERN.test(currentCommit) || candidateCommit !== currentCommit) {
    throw new Error(
      `Publication candidate commit ${candidateCommit} does not match checked-out commit ${currentCommit}`,
    );
  }
  const provenance = await computePublicationProvenance({
    repoRoot,
    candidateCommit,
    nodeVersion,
  });
  if (provenance.digest !== expectedDigest) {
    throw new Error(
      `Publication provenance drift: computed ${provenance.digest}, expected ${expectedDigest}`,
    );
  }
  return provenance;
}

/** @param {string} repoRoot */
export async function currentRepositoryCommit(repoRoot = DEFAULT_REPO_ROOT) {
  const commit = (await gitText(repoRoot, ["rev-parse", "HEAD"])).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) throw new Error("Git did not return an exact candidate commit");
  return commit;
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) flags[token.slice(2)] = true;
    else {
      flags[token.slice(2)] = value;
      index += 1;
    }
  }
  return flags;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const flags = parseArgs(process.argv.slice(2));
  const candidateCommit = String(flags["candidate-commit"] ?? "").toLowerCase();
  currentRepositoryCommit(DEFAULT_REPO_ROOT)
    .then(async (currentCommit) => {
      if (candidateCommit !== currentCommit) {
        throw new Error(
          `Requested candidate commit ${candidateCommit} does not match checked-out commit ${currentCommit}`,
        );
      }
      const provenance = await computePublicationProvenance({ candidateCommit });
      if (typeof flags["github-output"] === "string") {
        await appendFile(
          flags["github-output"],
          `candidate_commit=${candidateCommit}\nprovenance_digest=${provenance.digest}\n`,
        );
      }
      process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
