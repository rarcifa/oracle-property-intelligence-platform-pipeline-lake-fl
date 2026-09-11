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
  CLERMONT_PREPARED_RUN_SCHEMA_VERSION,
  clermontPreparedRunSchema,
  clermontPrepareTemplateSchema,
  type ClermontPreparedRun,
  type ClermontPrepareTemplate,
} from "./clermont-run-contracts.js";
import { initializeClermontRun } from "./clermont-run-store.js";

const SOURCE_SCOPE_FILES = Object.freeze([
  "pipeline/docs/lake-sources.yaml",
  "pipeline/scripts/lake/clermont-permits.mjs",
  "pipeline/src/counties/lake/clermont-permits.mjs",
  "pipeline/src/counties/lake/etrakit-adapter.mjs",
  "pipeline/src/counties/lake/permit-routing.mjs",
] as const);

const CONFIGURATION_SCOPE_FILES = Object.freeze([
  "pipeline/src/batch/clermont-preparation.ts",
  "pipeline/src/batch/clermont-executor.ts",
  "pipeline/src/batch/clermont-certifier.ts",
  "pipeline/src/batch/clermont-run-store.ts",
] as const);

const SCHEMA_SCOPE_FILES = Object.freeze([
  "pipeline/src/batch/clermont-contracts.ts",
  "pipeline/src/batch/clermont-run-contracts.ts",
  "pipeline/src/counties/lake/query-table.mjs",
  "pipeline/scripts/lake/build-query-table.sql",
] as const);

interface ScopeEntry {
  logicalPath: string;
  sha256: string;
  bytes: number;
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

function templateScope(template: ClermontPrepareTemplate) {
  const encoded = canonicalJson(template);
  return makeScope([
    {
      logicalPath: "input/clermont-prepare-template.json",
      sha256: sha256Text(encoded),
      bytes: Buffer.byteLength(encoded),
    },
  ]);
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
  const source = makeScope(await fileScope(options.repoRoot, SOURCE_SCOPE_FILES));
  const configuration = makeScope([
    ...templateScope(template).entries,
    ...(await fileScope(options.repoRoot, CONFIGURATION_SCOPE_FILES)),
  ]);
  configuration.entries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  configuration.aggregateSha256 = sha256Text(canonicalJson(configuration.entries));
  const schema = makeScope(await fileScope(options.repoRoot, SCHEMA_SCOPE_FILES));
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
  const expectedGroups = {
    source: prepared.scopes.source,
    configuration: prepared.scopes.configuration,
    schema: prepared.scopes.schema,
  };
  for (const [groupName, group] of Object.entries(expectedGroups)) {
    const actualEntries: ScopeEntry[] = [];
    for (const entry of group.entries) {
      if (entry.logicalPath === "input/clermont-prepare-template.json") {
        const encoded = canonicalJson(prepared.template);
        actualEntries.push({
          logicalPath: entry.logicalPath,
          sha256: sha256Text(encoded),
          bytes: Buffer.byteLength(encoded),
        });
      } else {
        actualEntries.push(...(await fileScope(options.repoRoot, [entry.logicalPath])));
      }
    }
    actualEntries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
    const aggregateSha256 = sha256Text(canonicalJson(actualEntries));
    if (
      aggregateSha256 !== group.aggregateSha256 ||
      canonicalJson(actualEntries) !== canonicalJson(group.entries)
    ) {
      throw new Error(`Prepared Clermont ${groupName} scope has drifted; create a new run`);
    }
  }
}
