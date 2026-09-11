#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadLastGoodClermontBaseline,
  materializeLastGoodClermontExport,
} from "../src/batch/clermont-baseline-store.js";
import { certifyClermontRun } from "../src/batch/clermont-certifier.js";
import {
  materializeClermontConsumption,
  promoteClermontRun,
} from "../src/batch/clermont-consumption.js";
import { clermontRunRequestSchema } from "../src/batch/clermont-contracts.js";
import {
  completeClermontStage,
  evaluateClermontCostGate,
  prepareClermontCoordinator,
  startClermontStage,
} from "../src/batch/clermont-coordinator.js";
import { runClermontAcquisition } from "../src/batch/clermont-executor.js";
import { prepareClermontRun } from "../src/batch/clermont-preparation.js";
import { clermontConsumptionRequestSchema } from "../src/batch/clermont-run-contracts.js";
import {
  loadClermontCoordinator,
  loadClermontPreparedRun,
  updateClermontCoordinator,
  writeClermontRunArtifact,
} from "../src/batch/clermont-run-store.js";
import { syncPromoteClermontBaselineToS3 } from "../src/batch/clermont-s3-baseline-store.js";
import { getClermontRunStatus } from "../src/batch/clermont-status.js";

export interface ClermontPlanCliArgs {
  command: "plan";
  requestPath: string;
  baselineStore: string | null;
  now: string;
}

export interface ClermontMaterializeCliArgs {
  command: "materialize-last-good";
  requestPath: string;
  baselineStore: string;
  outputPath: string;
  now: string;
}

function parseFlags(
  argv: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): { values: Map<string, string>; booleans: Set<string> } {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === undefined || !key.startsWith("--")) throw new Error("Expected a named flag");
    if (booleanFlags.includes(key)) {
      if (booleans.has(key)) throw new Error(`Duplicate flag ${key}`);
      booleans.add(key);
      continue;
    }
    if (!valueFlags.includes(key)) throw new Error(`Unknown ${argv[0]} flag ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Flag ${key} requires a value`);
    }
    if (values.has(key)) throw new Error(`Duplicate flag ${key}`);
    values.set(key, value);
    index += 1;
  }
  return { values, booleans };
}

function requireFlags(values: Map<string, string>, names: readonly string[]): void {
  const missing = names.filter((name) => !values.has(name));
  if (missing.length > 0) throw new Error(`Missing required flags: ${missing.join(", ")}`);
}

function requireNow(values: Map<string, string>): string {
  const now = values.get("--now");
  if (now === undefined || !Number.isFinite(Date.parse(now))) {
    throw new Error("A valid explicit --now ISO-8601 value is required");
  }
  return now;
}

export function parseClermontPlanCliArgs(argv: string[]): ClermontPlanCliArgs {
  if (argv[0] !== "plan") {
    throw new Error(
      "Usage: clermont-ingestion.ts plan --request <request.json> [--baseline-store <dir>] --now <ISO-8601>",
    );
  }
  const { values } = parseFlags(argv, ["--request", "--baseline-store", "--now"]);
  requireFlags(values, ["--request", "--now"]);
  return {
    command: "plan",
    requestPath: path.resolve(values.get("--request")!),
    baselineStore: values.has("--baseline-store")
      ? path.resolve(values.get("--baseline-store")!)
      : null,
    now: requireNow(values),
  };
}

export function parseClermontMaterializeCliArgs(argv: string[]): ClermontMaterializeCliArgs {
  if (argv[0] !== "materialize-last-good") {
    throw new Error(
      "Usage: clermont-ingestion.ts materialize-last-good --request <request.json> --baseline-store <dir> --output <csv> --now <ISO-8601>",
    );
  }
  const { values } = parseFlags(argv, ["--request", "--baseline-store", "--output", "--now"]);
  requireFlags(values, ["--request", "--baseline-store", "--output", "--now"]);
  return {
    command: "materialize-last-good",
    requestPath: path.resolve(values.get("--request")!),
    baselineStore: path.resolve(values.get("--baseline-store")!),
    outputPath: path.resolve(values.get("--output")!),
    now: requireNow(values),
  };
}

export async function planClermontIngestion(
  args: ClermontPlanCliArgs,
): Promise<ReturnType<typeof prepareClermontCoordinator>> {
  const request = clermontRunRequestSchema.parse(
    JSON.parse(await readFile(args.requestPath, "utf8")),
  );
  const costGate = evaluateClermontCostGate({ request, now: args.now });
  if (!costGate.authorized) {
    return prepareClermontCoordinator({ request, baseline: null, now: args.now });
  }
  let baseline = null;
  if (request.refreshMode === "incremental") {
    if (args.baselineStore === null || request.baseline.requiredSha256 === null) {
      throw new Error(
        "Incremental planning requires --baseline-store and an exact baseline digest",
      );
    }
    baseline = (
      await loadLastGoodClermontBaseline({
        storeRoot: args.baselineStore,
        now: args.now,
        maxAgeHours: request.baseline.maxAgeHours,
        expectedSignatures: request.signatures,
        expectedSha256: request.baseline.requiredSha256,
      })
    ).baseline;
  }
  return prepareClermontCoordinator({ request, baseline, now: args.now });
}

export async function materializeClermontIngestionBaseline(
  args: ClermontMaterializeCliArgs,
): Promise<Awaited<ReturnType<typeof materializeLastGoodClermontExport>>> {
  const request = clermontRunRequestSchema.parse(
    JSON.parse(await readFile(args.requestPath, "utf8")),
  );
  if (request.baseline.requiredSha256 === null) {
    throw new Error(
      "Materialization requires a request bound to an exact certified baseline digest",
    );
  }
  return materializeLastGoodClermontExport({
    storeRoot: args.baselineStore,
    outputPath: args.outputPath,
    now: args.now,
    maxAgeHours: request.baseline.maxAgeHours,
    expectedSignatures: request.signatures,
    expectedSha256: request.baseline.requiredSha256,
  });
}

async function executeCommand(argv: string[]): Promise<Record<string, unknown>> {
  const command = argv[0];
  if (command === "plan") {
    const state = await planClermontIngestion(parseClermontPlanCliArgs(argv));
    return {
      event: "clermont_ingestion_plan",
      runId: state.runId,
      state: state.state,
      estimate: state.estimate,
      refreshPlan: state.refreshPlan,
      nextAutomaticTransition: state.nextAutomaticTransition,
    };
  }
  if (command === "materialize-last-good") {
    return {
      event: "clermont_baseline_materialized",
      ...(await materializeClermontIngestionBaseline(parseClermontMaterializeCliArgs(argv))),
    };
  }
  if (command === "prepare") {
    const { values } = parseFlags(argv, [
      "--repo-root",
      "--template",
      "--run-store",
      "--baseline-store",
      "--now",
    ]);
    requireFlags(values, ["--repo-root", "--template", "--run-store", "--now"]);
    const result = await prepareClermontRun({
      repoRoot: path.resolve(values.get("--repo-root")!),
      templatePath: path.resolve(values.get("--template")!),
      runStore: path.resolve(values.get("--run-store")!),
      baselineStore: values.has("--baseline-store")
        ? path.resolve(values.get("--baseline-store")!)
        : null,
      now: requireNow(values),
    });
    return {
      event: "clermont_run_prepared",
      runId: result.prepared.request.runId,
      requestSha256: result.prepared.requestSha256,
      provenanceSha256: result.prepared.provenanceSha256,
      estimate: result.coordinator.estimate,
      state: result.coordinator.state,
      runDirectory: result.runDirectory,
    };
  }
  if (command === "run") {
    const { values, booleans } = parseFlags(
      argv,
      ["--repo-root", "--run-store", "--baseline-store", "--run-id", "--owner", "--now"],
      ["--live-fetch", "--prune-loose-after-seal"],
    );
    requireFlags(values, ["--repo-root", "--run-store", "--run-id", "--owner", "--now"]);
    return {
      event: "clermont_run_pass_complete",
      runId: values.get("--run-id")!,
      ...(await runClermontAcquisition({
        repoRoot: path.resolve(values.get("--repo-root")!),
        runStore: path.resolve(values.get("--run-store")!),
        baselineStore: values.has("--baseline-store")
          ? path.resolve(values.get("--baseline-store")!)
          : null,
        runId: values.get("--run-id")!,
        owner: values.get("--owner")!,
        now: requireNow(values),
        liveFetch: booleans.has("--live-fetch"),
        pruneLooseAfterSeal: booleans.has("--prune-loose-after-seal"),
      })),
    };
  }
  if (command === "status") {
    const { values } = parseFlags(argv, ["--run-store", "--run-id", "--now"]);
    requireFlags(values, ["--run-store", "--run-id", "--now"]);
    return {
      event: "clermont_run_status",
      ...(await getClermontRunStatus({
        runStore: path.resolve(values.get("--run-store")!),
        runId: values.get("--run-id")!,
        now: requireNow(values),
      })),
    };
  }
  if (command === "certify") {
    const { values } = parseFlags(argv, ["--repo-root", "--run-store", "--run-id", "--now"]);
    requireFlags(values, ["--repo-root", "--run-store", "--run-id", "--now"]);
    const result = await certifyClermontRun({
      repoRoot: path.resolve(values.get("--repo-root")!),
      runStore: path.resolve(values.get("--run-store")!),
      runId: values.get("--run-id")!,
      now: requireNow(values),
    });
    return {
      event: "clermont_run_certified",
      runId: values.get("--run-id")!,
      baselinePath: result.baselinePath,
      evidenceSha256: result.baseline.evidenceSha256,
      rows: result.baseline.mergedExport.rows,
    };
  }
  if (command === "promote") {
    const { values } = parseFlags(argv, [
      "--repo-root",
      "--run-store",
      "--baseline-store",
      "--run-id",
      "--output-relative-path",
      "--now",
    ]);
    requireFlags(values, ["--repo-root", "--run-store", "--baseline-store", "--run-id", "--now"]);
    return {
      event: "clermont_run_promoted",
      runId: values.get("--run-id")!,
      ...(await promoteClermontRun({
        repoRoot: path.resolve(values.get("--repo-root")!),
        runStore: path.resolve(values.get("--run-store")!),
        baselineStore: path.resolve(values.get("--baseline-store")!),
        runId: values.get("--run-id")!,
        now: requireNow(values),
        ...(values.has("--output-relative-path")
          ? { outputRelativePath: values.get("--output-relative-path")! }
          : {}),
      })),
    };
  }
  if (command === "sync-promote") {
    const { values, booleans } = parseFlags(
      argv,
      ["--run-store", "--baseline-store", "--run-id", "--bucket", "--prefix", "--region", "--now"],
      ["--live-sync"],
    );
    requireFlags(values, [
      "--run-store",
      "--baseline-store",
      "--run-id",
      "--bucket",
      "--prefix",
      "--region",
      "--now",
    ]);
    if (!booleans.has("--live-sync")) {
      throw new Error("S3 baseline mutation requires explicit --live-sync authorization");
    }
    const runStore = path.resolve(values.get("--run-store")!);
    const runId = values.get("--run-id")!;
    const prepared = await loadClermontPreparedRun(runStore, runId);
    const consumptionRequest = clermontConsumptionRequestSchema.parse(
      JSON.parse(
        await readFile(
          path.join(runStore, "runs", runId, "promotion", "consumption-request.json"),
          "utf8",
        ),
      ),
    );
    const result = await syncPromoteClermontBaselineToS3({
      region: values.get("--region")!,
      bucket: values.get("--bucket")!,
      prefix: values.get("--prefix")!,
      localBaselineStore: path.resolve(values.get("--baseline-store")!),
      baselineSha256: consumptionRequest.baselineSha256,
      expectedPriorSha256: prepared.request.baseline.requiredSha256,
      now: requireNow(values),
    });
    await writeClermontRunArtifact({
      storeRoot: runStore,
      runId,
      relativePath: "promotion/s3-promotion-receipt.json",
      value: result,
    });
    let coordinator = await loadClermontCoordinator(runStore, runId);
    if (coordinator.stages["baseline-promotion"].status !== "running") {
      coordinator = await updateClermontCoordinator({
        storeRoot: runStore,
        runId,
        expectedRevision: coordinator.revision,
        update: (state) => startClermontStage(state, "baseline-promotion", requireNow(values)),
      });
    }
    coordinator = await updateClermontCoordinator({
      storeRoot: runStore,
      runId,
      expectedRevision: coordinator.revision,
      update: (state) =>
        completeClermontStage(
          state,
          "baseline-promotion",
          result.baselineSha256,
          requireNow(values),
        ),
    });
    coordinator = await updateClermontCoordinator({
      storeRoot: runStore,
      runId,
      expectedRevision: coordinator.revision,
      update: (state) => startClermontStage(state, "publication-readiness", requireNow(values)),
    });
    await updateClermontCoordinator({
      storeRoot: runStore,
      runId,
      expectedRevision: coordinator.revision,
      update: (state) =>
        completeClermontStage(
          state,
          "publication-readiness",
          result.baselineSha256,
          requireNow(values),
        ),
    });
    return { event: "clermont_s3_baseline_promoted", runId, ...result };
  }
  if (command === "materialize") {
    const { values } = parseFlags(argv, [
      "--consumption-request",
      "--baseline-store",
      "--output-root",
      "--now",
    ]);
    requireFlags(values, ["--consumption-request", "--baseline-store", "--output-root", "--now"]);
    return {
      event: "clermont_consumption_materialized",
      ...(await materializeClermontConsumption({
        consumptionRequestPath: path.resolve(values.get("--consumption-request")!),
        baselineStore: path.resolve(values.get("--baseline-store")!),
        outputRoot: path.resolve(values.get("--output-root")!),
        now: requireNow(values),
      })),
    };
  }
  throw new Error(
    "Usage: clermont-ingestion.ts <prepare|run|status|certify|promote|sync-promote|materialize|plan|materialize-last-good> [flags]",
  );
}

async function main(): Promise<void> {
  const result = await executeCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
