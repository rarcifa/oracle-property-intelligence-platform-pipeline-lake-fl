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
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
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
// Every evidence artifact the runtime reads, not just the run pointer. The
// function shipped `latest.json` alone, so `/api/meta/run` answered with
// coverage, verification and runHistory all null and three evidence panels on
// the overview rendered empty — the run summary, the source limitations and the
// run history, which are exactly the claims the app exists to back up. The files
// were correct and already on IPFS; the Lambda simply could not see them.
//
// `row-hashes.json` is excluded: it is a 14 MB working file behind the delta
// computation, and nothing at runtime reads it.
const RUNTIME_ARTIFACT_EXCLUDES = new Set(["row-hashes.json"]);
const artifactNames = readdirSync(path.join(REPO_ROOT, "artifacts"))
  .filter((name) => name.endsWith(".json") && !RUNTIME_ARTIFACT_EXCLUDES.has(name))
  .sort();
for (const name of artifactNames) {
  cpSync(path.join(REPO_ROOT, "artifacts", name), path.join(BUNDLE, "artifacts", name));
}
if (!artifactNames.includes("latest.json")) {
  throw new Error("artifacts/latest.json is missing; the function cannot identify the served run");
}
log("bundled_runtime_artifacts", { files: artifactNames.length });

// The coverage snapshot and the published schema live in the run directory, not
// in artifacts/, and that directory is the 1.7 GB pipeline working tree. Only
// the small JSON record travels, laid out where ORACLE_RUN_DIR points.
const RUN_FILES = ["coverage.json", "schema.json", "index.json"];
const latestPointer = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "artifacts", "latest.json"), "utf8"),
);
const runSource = path.join(
  REPO_ROOT,
  "pipeline/data/artifacts/publish/lake/runs",
  String(latestPointer.runId),
);
mkdirSync(path.join(BUNDLE, "run"), { recursive: true });
for (const name of RUN_FILES) {
  const from = path.join(runSource, name);
  if (!existsSync(from)) {
    throw new Error(`${from} is missing; /api/meta/run would answer with nulls`);
  }
  cpSync(from, path.join(BUNDLE, "run", name));
}
log("bundled_run_record", { runId: latestPointer.runId, files: RUN_FILES.length });

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

// DuckDB's `httpfs` extension is a per-platform artefact exactly like the native
// binding above, and it is NOT statically linked. Nothing shipped it, so the
// function resolved it under `$HOME/.duckdb/extensions/` — and Lambda sets no
// HOME, so every request 502'd at cold start with "Can't find the home directory
// at ''". It passed on a developer machine only because one was already cached
// there. It is downloaded here for the target platform at the exact DuckDB
// version, so a deployed cold start needs no network access to duckdb.org and no
// writable extension directory.
const EXTENSION_PLATFORM = "linux_arm64";
const EXTENSIONS = ["httpfs"];

// The version must be DuckDB's own `version()`, not the npm package version:
// the extension path is keyed on it and a mismatch fails at cold start.
const duckdbVersion = execFileSync(
  "node",
  [
    "-e",
    "import('@duckdb/node-api').then(async (m) => {" +
      "const c = await (await m.DuckDBInstance.create(':memory:')).connect();" +
      "const r = await c.run('SELECT version() AS v');" +
      "process.stdout.write(String((await r.getRowObjects())[0].v)); });",
  ],
  { cwd: path.join(REPO_ROOT, "packages", "server"), encoding: "utf8" },
).trim();
if (!/^v\d+\.\d+\.\d+$/.test(duckdbVersion)) {
  throw new Error(`Unexpected DuckDB version ${JSON.stringify(duckdbVersion)}`);
}

const extensionLeaf = path.join(BUNDLE, "duckdb-extensions", duckdbVersion, EXTENSION_PLATFORM);
mkdirSync(extensionLeaf, { recursive: true });
for (const extension of EXTENSIONS) {
  const url = `https://extensions.duckdb.org/${duckdbVersion}/${EXTENSION_PLATFORM}/${extension}.duckdb_extension.gz`;
  log("downloading_duckdb_extension", { extension, version: duckdbVersion, url });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}; the function would fail at cold start`);
  }
  const binary = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const target = path.join(extensionLeaf, `${extension}.duckdb_extension`);
  writeFileSync(target, binary);
  if (statSync(target).size === 0) {
    throw new Error(`${target} is empty; the function would fail at cold start`);
  }
  log("bundled_duckdb_extension", { extension, bytes: binary.byteLength });
}

// Workspace-internal packages are not on any registry, so their compiled output
// is copied into node_modules under the names the server imports. Omitting one
// fails at COLD START, not at deploy: the function boots, the first request
// hits an unresolvable import, and the stack looks healthy from CloudFormation.
// `extra` carries non-code assets the package needs at runtime, which is how
// the retrieval index travels.
const WORKSPACE_PACKAGES = [
  { name: "shared", extra: [] },
  { name: "rag", extra: ["index-data"] },
];

for (const pkg of WORKSPACE_PACKAGES) {
  const from = path.join(REPO_ROOT, "packages", pkg.name);
  const to = path.join(BUNDLE, "node_modules", "@oracle-lake", pkg.name);
  if (!existsSync(path.join(from, "dist"))) {
    throw new Error(`packages/${pkg.name}/dist is missing. Run \`pnpm run build\` first.`);
  }
  mkdirSync(to, { recursive: true });
  cpSync(path.join(from, "dist"), path.join(to, "dist"), { recursive: true });
  cpSync(path.join(from, "package.json"), path.join(to, "package.json"));
  for (const asset of pkg.extra) {
    const assetFrom = path.join(from, asset);
    if (!existsSync(assetFrom)) {
      throw new Error(
        `packages/${pkg.name}/${asset} is missing; the function would fail at runtime`,
      );
    }
    cpSync(assetFrom, path.join(to, asset), { recursive: true });
  }
  log("bundled_workspace_package", { package: `@oracle-lake/${pkg.name}`, assets: pkg.extra });
}

// Every workspace import the compiled server actually makes must resolve from
// inside the bundle. This exists because the retrieval package was silently
// absent from an earlier bundle: the function would have deployed cleanly,
// reported healthy, and then failed on the first request with an unresolvable
// import. Scanning the emitted JavaScript catches that at build time, and
// catches the next one automatically rather than relying on someone
// remembering to update WORKSPACE_PACKAGES.
const imported = new Set();
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (entry.name.endsWith(".js")) {
      for (const match of readFileSync(full, "utf8").matchAll(
        /["'](@oracle-lake\/[a-z0-9-]+)["']/g,
      )) {
        imported.add(match[1]);
      }
    }
  }
};
scan(path.join(BUNDLE, "dist"));

const bundleRequire = createRequire(path.join(BUNDLE, "dist", "lambda.js"));
for (const specifier of [...imported].sort()) {
  try {
    bundleRequire.resolve(specifier);
  } catch {
    throw new Error(
      `${specifier} is imported by the server but does not resolve from the bundle. ` +
        "The function would deploy cleanly and then fail at cold start. " +
        "Add it to WORKSPACE_PACKAGES.",
    );
  }
}
log("workspace_imports_resolved", { specifiers: [...imported].sort() });

const UNZIPPED_LIMIT_BYTES = 250 * 1024 * 1024;
const finalBytes = dirBytes(BUNDLE);
if (finalBytes > UNZIPPED_LIMIT_BYTES) {
  throw new Error(
    `Bundle is ${finalBytes} bytes unzipped, over Lambda's ${UNZIPPED_LIMIT_BYTES} limit`,
  );
}

log("bundle_ready", { path: BUNDLE, bytes: dirBytes(BUNDLE) });
