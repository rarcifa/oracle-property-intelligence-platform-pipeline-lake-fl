#!/usr/bin/env node
/**
 * Assemble the Lambda deployment bundle at `infra/bundle`.
 *
 * Everything the function needs, laid out exactly as it will appear under
 * `/var/task`: the compiled server, its production dependencies with the Linux
 * ARM64 DuckDB bindings, the built UI, and the run pointer.
 *
 * The Linux bindings are installed explicitly because the build usually runs on
 * a developer's macOS machine, where npm would otherwise resolve only the
 * darwin binding and the function would fail at cold start with a missing
 * native module.
 *
 * Usage: node infra/scripts/build-lambda-bundle.mjs
 *
 * @module infra/scripts/build-lambda-bundle
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INFRA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(INFRA_DIR, "..");
const BUNDLE = path.join(INFRA_DIR, "bundle");

/**
 * @param {string} message - Event name.
 * @param {Record<string, unknown>} [fields] - Extra fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event: message, ...fields })}\n`);
}

/**
 * @param {string} dir - Directory to measure.
 * @returns {number} Total bytes.
 */
function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(full) : statSync(full).size;
  }
  return total;
}

const serverDist = path.join(REPO_ROOT, "packages", "server", "dist");
const uiDist = path.join(REPO_ROOT, "packages", "ui", "dist");
for (const required of [serverDist, uiDist]) {
  if (!existsSync(required)) {
    throw new Error(`Missing ${required}. Run \`pnpm run build\` first.`);
  }
}

rmSync(BUNDLE, { recursive: true, force: true });
mkdirSync(path.join(BUNDLE, "artifacts"), { recursive: true });

cpSync(serverDist, path.join(BUNDLE, "dist"), { recursive: true });
cpSync(uiDist, path.join(BUNDLE, "public"), { recursive: true });
cpSync(
  path.join(REPO_ROOT, "artifacts", "latest.json"),
  path.join(BUNDLE, "artifacts", "latest.json"),
);

// The bundle declares only what the function actually loads at runtime, so the
// zip stays small and the cold start stays short.
const serverPkg = JSON.parse(
  execFileSync("node", ["-p", "JSON.stringify(require('./packages/server/package.json'))"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }),
);
// Workspace-internal packages are stripped: npm cannot resolve a
// `workspace:*` specifier outside pnpm, and their compiled output is copied
// into node_modules below instead.
const runtimeDeps = Object.fromEntries(
  Object.entries(serverPkg.dependencies ?? {}).filter(
    ([, version]) => !String(version).startsWith("workspace:"),
  ),
);

writeFileSync(
  path.join(BUNDLE, "package.json"),
  `${JSON.stringify(
    {
      name: "oracle-lake-runtime-bundle",
      version: "0.1.0",
      private: true,
      type: "module",
      dependencies: runtimeDeps,
    },
    null,
    2,
  )}\n`,
);

log("installing_runtime_dependencies", { dependencies: Object.keys(runtimeDeps).length });
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: BUNDLE,
  stdio: "inherit",
});

// DuckDB's native binding is an OPTIONAL dependency resolved per platform, and
// npm on macOS installs only the darwin one. `--cpu`/`--os` do not change that:
// the bundle was verified to contain no platform binding at all, which would
// have failed at cold start with a missing native module rather than at deploy
// time. It is therefore installed explicitly, at the exact version the bindings
// package declares, and its presence is asserted below.
const bindingsPkg = JSON.parse(
  execFileSync("node", ["-p", "JSON.stringify(require('@duckdb/node-bindings/package.json'))"], {
    cwd: BUNDLE,
    encoding: "utf8",
  }),
);
const LAMBDA_BINDING = "@duckdb/node-bindings-linux-arm64";
const bindingVersion = bindingsPkg.optionalDependencies?.[LAMBDA_BINDING];
if (typeof bindingVersion !== "string") {
  throw new Error(`${LAMBDA_BINDING} is not an optional dependency of @duckdb/node-bindings`);
}
log("installing_lambda_binding", { package: LAMBDA_BINDING, version: bindingVersion });
execFileSync(
  "npm",
  [
    "install",
    "--no-save",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--force",
    `${LAMBDA_BINDING}@${bindingVersion}`,
  ],
  { cwd: BUNDLE, stdio: "inherit" },
);

const bindingDir = path.join(BUNDLE, "node_modules", LAMBDA_BINDING);
if (!existsSync(bindingDir)) {
  throw new Error(`${LAMBDA_BINDING} did not install; the function would fail at cold start`);
}

// Every other platform's binding is dead weight the function can never load,
// and each is around 90 MB. Lambda's unzipped limit is 250 MB, so leaving the
// build host's own binding in the bundle takes it most of the way there for no
// reason. Only the Linux ARM64 binding survives.
const duckdbDir = path.join(BUNDLE, "node_modules", "@duckdb");
for (const entry of readdirSync(duckdbDir, { withFileTypes: true })) {
  const isBinding = entry.name.startsWith("node-bindings-");
  if (isBinding && entry.name !== LAMBDA_BINDING.split("/")[1]) {
    rmSync(path.join(duckdbDir, entry.name), { recursive: true, force: true });
    log("pruned_foreign_binding", { package: `@duckdb/${entry.name}` });
  }
}

const UNZIPPED_LIMIT_BYTES = 250 * 1024 * 1024;
const finalBytes = dirBytes(BUNDLE);
if (finalBytes > UNZIPPED_LIMIT_BYTES) {
  throw new Error(
    `Bundle is ${finalBytes} bytes unzipped, over Lambda's ${UNZIPPED_LIMIT_BYTES} limit`,
  );
}

// The workspace-internal shared package is not on any registry, so its compiled
// output is copied into node_modules under the name the server imports.
const sharedTarget = path.join(BUNDLE, "node_modules", "@oracle-lake", "shared");
mkdirSync(sharedTarget, { recursive: true });
cpSync(path.join(REPO_ROOT, "packages", "shared", "dist"), path.join(sharedTarget, "dist"), {
  recursive: true,
});
cpSync(
  path.join(REPO_ROOT, "packages", "shared", "package.json"),
  path.join(sharedTarget, "package.json"),
);

log("bundle_ready", { path: BUNDLE, bytes: dirBytes(BUNDLE) });
