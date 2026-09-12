#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import {
  loadLastGoodClermontBaseline,
  materializeLastGoodClermontExport,
} from "../src/batch/clermont-baseline-store.js";
import { certifyClermontRun } from "../src/batch/clermont-certifier.js";
import {
  materializeClermontConsumption,
  promoteClermontRun,
  verifyClermontRemotePromotion,
} from "../src/batch/clermont-consumption.js";
import {
  clermontAuthorizationScopeDigest,
  clermontRunRequestSchema,
} from "../src/batch/clermont-contracts.js";
import {
  completeClermontStage,
  evaluateClermontCostGate,
  prepareClermontCoordinator,
  startClermontStage,
} from "../src/batch/clermont-coordinator.js";
import { runClermontAcquisition } from "../src/batch/clermont-executor.js";
import { prepareClermontRun } from "../src/batch/clermont-preparation.js";
import {
  loadClermontCoordinator,
  updateClermontCoordinator,
  writeClermontRunArtifact,
} from "../src/batch/clermont-run-store.js";
import { getClermontRunStatus } from "../src/batch/clermont-status.js";
import { canonicalJson } from "../src/batch/contracts.js";
import {
  clermontS3PromotionReceiptSchema,
  syncPromoteClermontBaselineToS3,
} from "../src/batch/clermont-s3-baseline-store.js";

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

const execFileAsync = promisify(execFile);
const CLERMONT_PRODUCTION_ACCOUNT = "122610508924";
const CLERMONT_PRODUCTION_REGION = "us-east-2";
const exactNotifierArnPattern = new RegExp(
  `^arn:aws:lambda:${CLERMONT_PRODUCTION_REGION}:${CLERMONT_PRODUCTION_ACCOUNT}:function:[A-Za-z0-9-_]+$`,
);
const notifierEventSchema = z.object({
  summary: z.string().min(1).max(256),
  source: z.string().min(1).max(128),
  dedupKey: z.string().min(1).max(255),
  customDetails: z.object({
    runId: z.string().min(1).max(128),
    state: z.literal("FAILED_EXHAUSTED"),
  }),
});
const lambdaInvocationSchema = z.object({
  StatusCode: z.literal(200),
  FunctionError: z.undefined().optional(),
});
const notifierReceiptSchema = z.object({
  status: z.literal("triggered"),
  dedupKey: z.string().min(1).max(255),
});

export type ClermontNotifierEvent = z.infer<typeof notifierEventSchema>;
type ClermontCoordinatorState =
  "READY" | "RUNNING" | "WAITING_HUMAN" | "FAILED_EXHAUSTED" | "COMPLETE";
type LambdaInvokeTransport = (
  notifierArn: string,
  event: ClermontNotifierEvent,
) => Promise<{ invocation: unknown; payload: unknown }>;

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const [major, minor] = version.split(".").map(Number);
  if (major !== 22 || minor === undefined || minor < 18) {
    throw new Error(`Node 22.18.0 through Node 22.x is required; received ${version}`);
  }
}

export function assertExactClermontNotifierArn(notifierArn: string): void {
  if (!exactNotifierArnPattern.test(notifierArn)) {
    throw new Error(
      `Clermont failure notifier must be one exact production Lambda ARN in ${CLERMONT_PRODUCTION_ACCOUNT}/${CLERMONT_PRODUCTION_REGION}`,
    );
  }
}

export function clermontNotifierAwsCliArguments(
  notifierArn: string,
  event: ClermontNotifierEvent,
  outputPath: string,
): string[] {
  assertExactClermontNotifierArn(notifierArn);
  return [
    "lambda",
    "invoke",
    "--region",
    CLERMONT_PRODUCTION_REGION,
    "--function-name",
    notifierArn,
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    JSON.stringify(event),
    outputPath,
  ];
}

async function invokeLambdaWithAwsCli(
  notifierArn: string,
  event: ClermontNotifierEvent,
): Promise<{ invocation: unknown; payload: unknown }> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "clermont-notifier-"));
  const outputPath = path.join(temporaryDirectory, "receipt.json");
  try {
    const result = await execFileAsync(
      "aws",
      clermontNotifierAwsCliArguments(notifierArn, event, outputPath),
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return {
      invocation: JSON.parse(result.stdout) as unknown,
      payload: JSON.parse(await readFile(outputPath, "utf8")) as unknown,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function invokeClermontFailureNotifier(
  notifierArn: string,
  rawEvent: ClermontNotifierEvent,
  transport: LambdaInvokeTransport = invokeLambdaWithAwsCli,
): Promise<z.infer<typeof notifierReceiptSchema>> {
  assertExactClermontNotifierArn(notifierArn);
  const event = notifierEventSchema.parse(rawEvent);
  const result = await transport(notifierArn, event);
  const invocation = lambdaInvocationSchema.safeParse(result.invocation);
  const receipt = notifierReceiptSchema.safeParse(result.payload);
  if (!invocation.success || !receipt.success) {
    throw new Error("Clermont failure notifier returned an invalid invocation receipt");
  }
  return receipt.data;
}

export async function runWithFailedExhaustedPaging<T>(options: {
  operation: () => Promise<T>;
  loadState: () => Promise<ClermontCoordinatorState>;
  invokeNotifier: (
    notifierArn: string,
    event: ClermontNotifierEvent,
  ) => Promise<{ status: "triggered"; dedupKey: string }>;
  notifierArn: string;
  runId: string;
  reportNotificationFailure?: (message: string) => void;
}): Promise<T> {
  try {
    return await options.operation();
  } catch (originalError) {
    const report =
      options.reportNotificationFailure ??
      ((message: string): void => {
        process.stderr.write(`${message}\n`);
      });
    try {
      const state = await options.loadState();
      if (state === "FAILED_EXHAUSTED") {
        await options.invokeNotifier(options.notifierArn, {
          summary: `Clermont acquisition ${options.runId} exhausted its retry budget`,
          source: "clermont-ingestion-cli",
          dedupKey: `clermont-acquisition/${options.runId}/FAILED_EXHAUSTED`,
          customDetails: { runId: options.runId, state },
        });
      }
    } catch (notificationError) {
      report(
        `clermont_terminal_notification_failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
      );
    }
    throw originalError;
  }
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

export async function executeCommand(argv: string[]): Promise<Record<string, unknown>> {
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
      authorizationScopeSha256: clermontAuthorizationScopeDigest(result.prepared.request),
      provenanceSha256: result.prepared.provenanceSha256,
      estimate: result.coordinator.estimate,
      state: result.coordinator.state,
      runDirectory: result.runDirectory,
    };
  }
  if (command === "run") {
    const { values, booleans } = parseFlags(
      argv,
      [
        "--repo-root",
        "--run-store",
        "--baseline-store",
        "--run-id",
        "--owner",
        "--now",
        "--failure-notifier-arn",
      ],
      ["--live-fetch", "--prune-loose-after-seal"],
    );
    requireFlags(values, [
      "--repo-root",
      "--run-store",
      "--run-id",
      "--owner",
      "--now",
      "--failure-notifier-arn",
    ]);
    if (booleans.has("--prune-loose-after-seal")) {
      throw new Error(
        "The first production Clermont capture must retain loose evidence; pruning is disabled",
      );
    }
    const runStore = path.resolve(values.get("--run-store")!);
    const runId = values.get("--run-id")!;
    const notifierArn = values.get("--failure-notifier-arn")!;
    assertExactClermontNotifierArn(notifierArn);
    const acquisition = await runWithFailedExhaustedPaging({
      operation: () =>
        runClermontAcquisition({
          repoRoot: path.resolve(values.get("--repo-root")!),
          runStore,
          baselineStore: values.has("--baseline-store")
            ? path.resolve(values.get("--baseline-store")!)
            : null,
          runId,
          owner: values.get("--owner")!,
          now: requireNow(values),
          liveFetch: booleans.has("--live-fetch"),
          pruneLooseAfterSeal: false,
        }),
      loadState: async () => (await loadClermontCoordinator(runStore, runId)).state,
      invokeNotifier: invokeClermontFailureNotifier,
      notifierArn,
      runId,
    });
    return {
      event: "clermont_run_pass_complete",
      runId,
      ...acquisition,
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
      ["--repo-root", "--run-store", "--baseline-store", "--run-id", "--now"],
      ["--live-sync"],
    );
    requireFlags(values, ["--repo-root", "--run-store", "--baseline-store", "--run-id", "--now"]);
    if (!booleans.has("--live-sync")) {
      throw new Error("S3 baseline mutation requires explicit --live-sync authorization");
    }
    const runStore = path.resolve(values.get("--run-store")!);
    const runId = values.get("--run-id")!;
    const observedAt = requireNow(values);
    const verified = await verifyClermontRemotePromotion({
      repoRoot: path.resolve(values.get("--repo-root")!),
      runStore,
      baselineStore: path.resolve(values.get("--baseline-store")!),
      runId,
      now: observedAt,
    });
    const destination = verified.prepared.request.remoteBaseline;
    const receiptPath = path.join(
      runStore,
      "runs",
      runId,
      "promotion",
      "s3-promotion-receipt.json",
    );
    const priorReceipt = await readFile(receiptPath, "utf8")
      .then((encoded) => clermontS3PromotionReceiptSchema.parse(JSON.parse(encoded)))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    if (
      priorReceipt !== null &&
      (priorReceipt.accountId !== destination.accountId ||
        priorReceipt.region !== destination.region ||
        priorReceipt.bucket !== destination.bucket ||
        priorReceipt.prefix !== destination.prefix ||
        priorReceipt.baselineSha256 !== verified.consumptionRequest.baselineSha256)
    ) {
      throw new Error("Persisted S3 promotion receipt disagrees with the prepared destination");
    }
    const observedResult = await syncPromoteClermontBaselineToS3({
      accountId: destination.accountId,
      region: destination.region,
      bucket: destination.bucket,
      prefix: destination.prefix,
      maxRetainedBytes: destination.maxRetainedBytes,
      localBaselineStore: path.resolve(values.get("--baseline-store")!),
      baselineSha256: verified.consumptionRequest.baselineSha256,
      expectedPriorSha256: verified.prepared.request.baseline.requiredSha256,
      now: observedAt,
      recoverOnly: priorReceipt !== null,
    });
    const receiptIdentity = (value: typeof observedResult) => ({
      accountId: value.accountId,
      region: value.region,
      bucket: value.bucket,
      prefix: value.prefix,
      baselineSha256: value.baselineSha256,
      pointerKey: value.pointerKey,
      pointerEtag: value.pointerEtag,
      objects: value.objects.map(({ action: _action, ...object }) => object),
    });
    if (
      priorReceipt !== null &&
      canonicalJson(receiptIdentity(priorReceipt)) !==
        canonicalJson(receiptIdentity(observedResult))
    ) {
      throw new Error("Persisted S3 promotion receipt failed exact remote readback");
    }
    const result = priorReceipt ?? observedResult;
    await writeClermontRunArtifact({
      storeRoot: runStore,
      runId,
      relativePath: "promotion/s3-promotion-receipt.json",
      value: result,
    });
    let coordinator = await loadClermontCoordinator(runStore, runId);
    if (
      coordinator.stages["baseline-promotion"].status !== "running" &&
      coordinator.stages["baseline-promotion"].status !== "complete"
    ) {
      coordinator = await updateClermontCoordinator({
        storeRoot: runStore,
        runId,
        expectedRevision: coordinator.revision,
        update: (state) => startClermontStage(state, "baseline-promotion", observedAt),
      });
    }
    if (coordinator.stages["baseline-promotion"].status === "running") {
      coordinator = await updateClermontCoordinator({
        storeRoot: runStore,
        runId,
        expectedRevision: coordinator.revision,
        update: (state) =>
          completeClermontStage(state, "baseline-promotion", result.baselineSha256, observedAt),
      });
    }
    if (
      coordinator.stages["publication-readiness"].status !== "running" &&
      coordinator.stages["publication-readiness"].status !== "complete"
    ) {
      coordinator = await updateClermontCoordinator({
        storeRoot: runStore,
        runId,
        expectedRevision: coordinator.revision,
        update: (state) => startClermontStage(state, "publication-readiness", observedAt),
      });
    }
    if (coordinator.stages["publication-readiness"].status === "running") {
      await updateClermontCoordinator({
        storeRoot: runStore,
        runId,
        expectedRevision: coordinator.revision,
        update: (state) =>
          completeClermontStage(state, "publication-readiness", result.baselineSha256, observedAt),
      });
    }
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
  assertSupportedNodeRuntime();
  const result = await executeCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
