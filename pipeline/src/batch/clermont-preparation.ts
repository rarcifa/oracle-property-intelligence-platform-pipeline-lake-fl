import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { canonicalJson, sha256Text } from "./contracts.js";
import {
  CLERMONT_PERMIT_YEARS,
  CLERMONT_REQUEST_SCHEMA_VERSION,
  clermontRequestDigest,
  clermontRunRequestSchema,
  type ClermontCertifiedBaseline,
} from "./clermont-contracts.js";
import { createClermontWorkerState, prepareClermontCoordinator } from "./clermont-coordinator.js";
import { loadLastGoodClermontBaseline } from "./clermont-baseline-store.js";
import {
  CLERMONT_CONFIGURATION_SCOPE_FILES,
  CLERMONT_EXECUTOR_SCOPE_PATH,
  CLERMONT_PREPARED_RUN_SCHEMA_VERSION,
  CLERMONT_SCHEMA_SCOPE_FILES,
  CLERMONT_SOURCE_SCOPE_FILES,
  clermontPreparedRunSchema,
  clermontPrepareTemplateSchema,
  type ClermontPreparedRun,
} from "./clermont-run-contracts.js";
import { initializeClermontRun } from "./clermont-run-store.js";

interface ScopeEntry {
  logicalPath: string;
  sha256: string;
  bytes: number;
}

function virtualScopeEntry(logicalPath: string, value: unknown): ScopeEntry {
  const encoded = canonicalJson(value);
  return {
    logicalPath,
    sha256: sha256Text(encoded),
    bytes: Buffer.byteLength(encoded),
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function fileScope(repoRoot: string, logicalPaths: readonly string[]): Promise<ScopeEntry[]> {
  const root = path.resolve(repoRoot);
  return Promise.all(
    [...logicalPaths].sort().map(async (logicalPath) => {
      const absolutePath = path.resolve(root, logicalPath);
      if (!absolutePath.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Scope path escapes repository root: ${logicalPath}`);
      }
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) throw new Error(`Scope path is not a file: ${logicalPath}`);
      return { logicalPath, sha256: await sha256File(absolutePath), bytes: fileStat.size };
    }),
  );
}

function makeScope(entries: ScopeEntry[]) {
  return {
    entries,
    aggregateSha256: sha256Text(canonicalJson(entries)),
  };
}

export async function prepareClermontRun(options: {
  repoRoot: string;
  templatePath: string;
  runStore: string;
  baselineStore: string | null;
  now: string;
}): Promise<{
  prepared: ClermontPreparedRun;
  coordinator: ReturnType<typeof prepareClermontCoordinator>;
  runDirectory: string;
}> {
  if (!Number.isFinite(Date.parse(options.now))) throw new Error("now must be ISO-8601");
  const template = clermontPrepareTemplateSchema.parse(
    JSON.parse(await readFile(options.templatePath, "utf8")),
  );
  const source = makeScope(await fileScope(options.repoRoot, CLERMONT_SOURCE_SCOPE_FILES));
  const configuration = makeScope(
    [
      ...(await fileScope(options.repoRoot, CLERMONT_CONFIGURATION_SCOPE_FILES)),
      virtualScopeEntry(CLERMONT_EXECUTOR_SCOPE_PATH, template.executor),
    ].sort((left, right) =>
      left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0,
    ),
  );
  const schema = makeScope(await fileScope(options.repoRoot, CLERMONT_SCHEMA_SCOPE_FILES));
  const signatures = {
    sourceSha256: source.aggregateSha256,
    configurationSha256: configuration.aggregateSha256,
    schemaSha256: schema.aggregateSha256,
  };
  const request = clermontRunRequestSchema.parse({
    schemaVersion: CLERMONT_REQUEST_SCHEMA_VERSION,
    runId: template.runId,
    county: "lake",
    jurisdiction: "clermont",
    sourceSystem: "lake_clermont_etrakit_permits",
    requestedYears: [...CLERMONT_PERMIT_YEARS],
    refreshMode: template.refreshMode,
    asOfYear: 2026,
    runtime: template.runtime,
    remoteBaseline: template.remoteBaseline,
    signatures,
    baseline: template.baseline,
    benchmark: template.benchmark,
    limits: template.limits,
    authorization: template.authorization,
  });

  let baseline: ClermontCertifiedBaseline | null = null;
  if (request.refreshMode === "incremental") {
    if (options.baselineStore === null || request.baseline.requiredSha256 === null) {
      throw new Error("Incremental preparation requires a baseline store and exact digest");
    }
    baseline = (
      await loadLastGoodClermontBaseline({
        storeRoot: options.baselineStore,
        now: options.now,
        maxAgeHours: request.baseline.maxAgeHours,
        expectedSignatures: signatures,
        expectedSha256: request.baseline.requiredSha256,
      })
    ).baseline;
  }

  const plannedCoordinator = prepareClermontCoordinator({ request, baseline, now: options.now });
  const requestSha256 = clermontRequestDigest(request);
  const provenanceSha256 = sha256Text(
    canonicalJson({ source, configuration, schema, baseline: request.baseline.requiredSha256 }),
  );
  if (plannedCoordinator.requestSha256 !== requestSha256) {
    throw new Error("Coordinator did not bind the exact prepared request");
  }
  const coordinator = { ...plannedCoordinator, provenanceSha256 };
  const prepared = clermontPreparedRunSchema.parse({
    schemaVersion: CLERMONT_PREPARED_RUN_SCHEMA_VERSION,
    preparedAt: options.now,
    requestSha256,
    provenanceSha256,
    template,
    request,
    executor: template.executor,
    scopes: { source, configuration, schema },
  });
  const runDirectory = await initializeClermontRun({
    storeRoot: options.runStore,
    prepared,
    coordinator,
    workers: CLERMONT_PERMIT_YEARS.map((year) => createClermontWorkerState(year, signatures)),
  });
  return { prepared, coordinator, runDirectory };
}

export async function verifyClermontPreparedScopes(options: {
  repoRoot: string;
  prepared: ClermontPreparedRun;
}): Promise<void> {
  const prepared = clermontPreparedRunSchema.parse(options.prepared);
  if (
    prepared.request.runtime.nodeVersion !== process.version ||
    prepared.request.runtime.platform !== process.platform ||
    prepared.request.runtime.architecture !== process.arch
  ) {
    throw new Error("Prepared Clermont runtime identity does not match the active process");
  }
  const actualGroups = {
    source: makeScope(await fileScope(options.repoRoot, CLERMONT_SOURCE_SCOPE_FILES)),
    configuration: makeScope(
      [
        ...(await fileScope(options.repoRoot, CLERMONT_CONFIGURATION_SCOPE_FILES)),
        virtualScopeEntry(CLERMONT_EXECUTOR_SCOPE_PATH, prepared.template.executor),
      ].sort((left, right) =>
        left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0,
      ),
    ),
    schema: makeScope(await fileScope(options.repoRoot, CLERMONT_SCHEMA_SCOPE_FILES)),
  };
  for (const [groupName, actual] of Object.entries(actualGroups)) {
    const expected = prepared.scopes[groupName as keyof typeof prepared.scopes];
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`Prepared Clermont ${groupName} scope has drifted; create a new run`);
    }
  }
}
