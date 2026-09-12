import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import {
  downloadVerifiedObject,
  getVerifiedJsonIfExists,
  putImmutableJson,
  uploadDirectoryImmutable,
} from "./s3-integrity.js";
import { planPermitBatchCost } from "./cost-plan.js";
import {
  createBatchWorkerObserver,
  emitBatchCostPrediction,
} from "./worker-observability.js";

const runtimeRoot = path.resolve(
  process.env.ORACLE_RUNTIME_ROOT ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const s3 = new S3Client({});

interface PermitProfile {
  countyKey: string;
}

interface PermitProfilesModule {
  requirePermitProfile(countyKey: string): PermitProfile;
}

interface EnrichmentProfile {
  queryTable: { schemaFields: Record<string, unknown> };
}

interface EnrichmentProfilesModule {
  requireEnrichmentProfile(countyKey: string): EnrichmentProfile;
}

interface PermitBulkModule {
  exportJaxPermitBulkArtifacts(
    options: Record<string, unknown>,
  ): Promise<{
    counters: Record<string, unknown>;
    snapshot: Record<string, unknown>;
    propertyRows: number;
    propertiesWithPermits: number;
  }>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumberEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

async function runtimeModule<T>(relativePath: string): Promise<T> {
  return (await import(
    pathToFileURL(path.join(runtimeRoot, relativePath)).href
  )) as T;
}

const observer = createBatchWorkerObserver("permit");
const log = observer.info;

async function main(): Promise<void> {
  const bucket = requiredEnvironment("ARTIFACT_BUCKET");
  const runId = requiredEnvironment("PERMIT_RUN_ID");
  const county = requiredEnvironment("PERMIT_COUNTY");
  const queryTableInput = {
    key: requiredEnvironment("PERMIT_INPUT_QUERY_TABLE_KEY"),
    bytes: positiveIntegerEnvironment("PERMIT_INPUT_QUERY_TABLE_BYTES"),
    sha256: requiredEnvironment("PERMIT_INPUT_QUERY_TABLE_SHA256"),
  };
  const coverageInput = {
    key: requiredEnvironment("PERMIT_INPUT_COVERAGE_KEY"),
    bytes: positiveIntegerEnvironment("PERMIT_INPUT_COVERAGE_BYTES"),
    sha256: requiredEnvironment("PERMIT_INPUT_COVERAGE_SHA256"),
  };
  const costPlan = planPermitBatchCost(
    queryTableInput.bytes,
    coverageInput.bytes,
    positiveNumberEnvironment("MAX_COST_CEILING_USD"),
  );
  emitBatchCostPrediction(costPlan.estimatedUsd);
  if (!costPlan.allowed) {
    throw new Error(
      `Predicted permit run cost $${costPlan.estimatedUsd.toFixed(2)} exceeds the deployment ceiling $${costPlan.ceilingUsd.toFixed(2)}`,
    );
  }
  log("permit_cost_gate_passed", {
    runId,
    estimatedUsd: costPlan.estimatedUsd,
    ceilingUsd: costPlan.ceilingUsd,
  });
  const handoffKey = `runs/${runId}/handoffs/permit.json`;
  const completed = await getVerifiedJsonIfExists(s3, bucket, handoffKey);
  if (completed !== null) {
    log("permit_stage_already_complete", { runId, handoffKey });
    return;
  }
  const workDir = "/work/permit";
  const inputDir = path.join(workDir, "input");
  const outputDir = path.join(workDir, "output");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(inputDir, { recursive: true });
  const inputPropertyParquet = path.join(inputDir, "query-table.parquet");
  const inputCoveragePath = path.join(inputDir, "dataset-coverage.json");
  await Promise.all([
    downloadVerifiedObject(
      s3,
      bucket,
      queryTableInput,
      inputPropertyParquet,
    ),
    downloadVerifiedObject(
      s3,
      bucket,
      coverageInput,
      inputCoveragePath,
    ),
  ]);
  const permitProfiles = await runtimeModule<PermitProfilesModule>(
    "src/counties/permit-profiles.mjs",
  );
  const enrichmentProfiles = await runtimeModule<EnrichmentProfilesModule>(
    "src/counties/enrichment-profiles.mjs",
  );
  const bulkModule = await runtimeModule<PermitBulkModule>(
    "src/permits/bulk-export.mjs",
  );
  const profile = permitProfiles.requirePermitProfile(county);
  const enrichmentProfile =
    enrichmentProfiles.requireEnrichmentProfile(county);
  log("permit_bulk_export_started", { runId, county });
  const result = await bulkModule.exportJaxPermitBulkArtifacts({
    inputPropertyParquet,
    inputCoveragePath,
    outputDir,
    profile,
    propertySchemaFields: enrichmentProfile.queryTable.schemaFields,
    jobId: runId,
    progress: (progress: Record<string, unknown>) =>
      log("permit_bulk_progress", progress),
  });
  const artifacts = await uploadDirectoryImmutable(
    s3,
    bucket,
    `runs/${runId}/artifacts/permit`,
    outputDir,
  );
  const handoff = {
    schemaVersion: "elephant.permit-batch-handoff.v1",
    runId,
    county,
    status: "complete",
    createdAt: new Date().toISOString(),
    runtimeImageProvenance:
      process.env.RUNTIME_IMAGE_PROVENANCE ?? null,
    input: {
      queryTable: queryTableInput,
      coverage: coverageInput,
    },
    artifacts,
    summary: {
      snapshot: result.snapshot,
      counters: result.counters,
      propertyRows: result.propertyRows,
      propertiesWithPermits: result.propertiesWithPermits,
    },
  };
  await putImmutableJson(s3, bucket, handoffKey, handoff);
  log("permit_bulk_export_complete", {
    runId,
    county,
    handoffKey,
    artifactCount: artifacts.length,
    counters: result.counters,
  });
}

observer.run(main).catch(() => {
  process.exitCode = 1;
});
