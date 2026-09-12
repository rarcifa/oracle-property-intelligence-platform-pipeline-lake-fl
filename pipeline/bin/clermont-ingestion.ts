#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  acquireClermontRunLock,
  clermontRunDirectory,
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
const exactFailureTopicArnPattern = new RegExp(
  `^arn:aws:sns:${CLERMONT_PRODUCTION_REGION}:${CLERMONT_PRODUCTION_ACCOUNT}:[A-Za-z0-9-_]+$`,
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
const snsPublishReceiptSchema = z.object({
  MessageId: z.string().uuid(),
});
const terminalNotificationSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-terminal-notification.v1"),
    runId: z
      .string()
      .min(8)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    coordinatorRevision: z.number().int().positive(),
    transportKind: z.enum(["pagerduty", "sns-email"]),
    targetArn: z.string().min(1),
    dedupKey: z.string().min(1).max(255),
    status: z.enum(["armed", "pending", "delivered"]),
    attempts: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
    nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
    deliveredAt: z.string().datetime({ offset: true }).nullable(),
    receiptId: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "delivered") {
      if (
        value.attempts < 1 ||
        value.lastAttemptAt === null ||
        value.nextAttemptAt !== null ||
        value.deliveredAt === null ||
        value.receiptId === null ||
        value.updatedAt !== value.lastAttemptAt ||
        value.deliveredAt !== value.lastAttemptAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Delivered terminal notifications require consistent durable delivery evidence",
        });
      }
      if (
        value.receiptId !== null &&
        value.transportKind === "sns-email" &&
        !z.string().uuid().safeParse(value.receiptId).success
      ) {
        context.addIssue({
          code: "custom",
          path: ["receiptId"],
          message: "Delivered SNS notifications require a UUID MessageId",
        });
      }
      if (
        value.receiptId !== null &&
        value.transportKind === "pagerduty" &&
        value.receiptId !== value.dedupKey
      ) {
        context.addIssue({
          code: "custom",
          path: ["receiptId"],
          message: "Delivered PagerDuty notifications require the bound dedup key",
        });
      }
    } else {
      if (value.deliveredAt !== null || value.receiptId !== null) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending terminal notifications cannot claim delivery evidence",
        });
      }
      if (
        (value.status === "armed" &&
          (value.attempts !== 0 || value.lastAttemptAt !== null || value.nextAttemptAt !== null)) ||
        (value.status === "pending" &&
          ((value.attempts === 0 &&
            (value.lastAttemptAt !== null || value.nextAttemptAt !== null)) ||
            (value.attempts > 0 && (value.lastAttemptAt === null || value.nextAttemptAt === null))))
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempts"],
          message: "Pending terminal notification attempts require consistent retry evidence",
        });
      }
    }
  });

export type ClermontNotifierEvent = z.infer<typeof notifierEventSchema>;
type ClermontCoordinatorState =
  "READY" | "RUNNING" | "WAITING_HUMAN" | "FAILED_EXHAUSTED" | "COMPLETE";
interface ClermontCoordinatorSnapshot {
  runId: string;
  revision: number;
  state: ClermontCoordinatorState;
}
type ClermontTerminalNotification = z.infer<typeof terminalNotificationSchema>;
type ClermontNotificationReceipt = {
  status: "triggered";
  dedupKey: string;
  receiptId?: string;
};
type LambdaInvokeTransport = (
  notifierArn: string,
  event: ClermontNotifierEvent,
) => Promise<{ invocation: unknown; payload: unknown }>;
type SnsPublishTransport = (topicArn: string, event: ClermontNotifierEvent) => Promise<unknown>;

export type ClermontFailureTransport =
  { kind: "pagerduty"; targetArn: string } | { kind: "sns-email"; targetArn: string };

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

export function assertExactClermontFailureTopicArn(topicArn: string): void {
  if (!exactFailureTopicArnPattern.test(topicArn)) {
    throw new Error(
      `Clermont failure topic must be one exact production SNS ARN in ${CLERMONT_PRODUCTION_ACCOUNT}/${CLERMONT_PRODUCTION_REGION}`,
    );
  }
}

export function selectClermontFailureTransport(options: {
  notifierArn?: string;
  topicArn?: string;
}): ClermontFailureTransport {
  const configured = [options.notifierArn, options.topicArn].filter(
    (value): value is string => value !== undefined,
  );
  if (configured.length !== 1) {
    throw new Error("Exactly one of --failure-notifier-arn or --failure-topic-arn is required");
  }
  if (options.notifierArn !== undefined) {
    assertExactClermontNotifierArn(options.notifierArn);
    return { kind: "pagerduty", targetArn: options.notifierArn };
  }
  assertExactClermontFailureTopicArn(options.topicArn!);
  return { kind: "sns-email", targetArn: options.topicArn! };
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

export function clermontFailureTopicAwsCliArguments(
  topicArn: string,
  event: ClermontNotifierEvent,
): string[] {
  assertExactClermontFailureTopicArn(topicArn);
  return [
    "sns",
    "publish",
    "--region",
    CLERMONT_PRODUCTION_REGION,
    "--topic-arn",
    topicArn,
    "--subject",
    "Clermont acquisition failed",
    "--message",
    JSON.stringify(event),
    "--output",
    "json",
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

async function publishSnsWithAwsCli(
  topicArn: string,
  event: ClermontNotifierEvent,
): Promise<unknown> {
  const result = await execFileAsync("aws", clermontFailureTopicAwsCliArguments(topicArn, event), {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as unknown;
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

export async function invokeClermontFailureTopic(
  topicArn: string,
  rawEvent: ClermontNotifierEvent,
  transport: SnsPublishTransport = publishSnsWithAwsCli,
): Promise<ClermontNotificationReceipt> {
  assertExactClermontFailureTopicArn(topicArn);
  const event = notifierEventSchema.parse(rawEvent);
  const receipt = snsPublishReceiptSchema.safeParse(await transport(topicArn, event));
  if (!receipt.success) {
    throw new Error("Clermont failure topic returned an invalid publish receipt");
  }
  return {
    status: "triggered",
    dedupKey: event.dedupKey,
    receiptId: receipt.data.MessageId,
  };
}

function terminalNotificationPath(runStore: string, runId: string): string {
  return path.join(clermontRunDirectory(runStore, runId), "terminal-notification.json");
}

export async function loadClermontTerminalNotification(
  runStore: string,
  runId: string,
): Promise<ClermontTerminalNotification | null> {
  try {
    return terminalNotificationSchema.parse(
      JSON.parse(await readFile(terminalNotificationPath(runStore, runId), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function persistClermontTerminalNotification(
  runStore: string,
  notification: ClermontTerminalNotification,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const parsed = terminalNotificationSchema.parse(notification);
  const target = terminalNotificationPath(runStore, parsed.runId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.terminal-notification.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${canonicalJson(parsed)}\n`, { encoding: "utf8", flag: "wx" });
    await assertOwned();
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function armClermontTerminalNotification(options: {
  runStore: string;
  runId: string;
  coordinator: ClermontCoordinatorSnapshot;
  transportKind: ClermontFailureTransport["kind"];
  targetArn: string;
  now?: () => Date;
}): Promise<void> {
  if (options.coordinator.runId !== options.runId) {
    throw new Error("Terminal notification arm requires the exact coordinator run identity");
  }
  if (
    options.coordinator.state === "FAILED_EXHAUSTED" ||
    options.coordinator.state === "COMPLETE"
  ) {
    return;
  }
  if (options.transportKind === "pagerduty") assertExactClermontNotifierArn(options.targetArn);
  else assertExactClermontFailureTopicArn(options.targetArn);
  const dedupKey = `clermont-acquisition/${options.runId}/FAILED_EXHAUSTED`;
  const lock = await acquireClermontRunLock(clermontRunDirectory(options.runStore, options.runId));
  try {
    const current = await loadClermontTerminalNotification(options.runStore, options.runId);
    if (current !== null) {
      if (
        current.runId !== options.runId ||
        current.transportKind !== options.transportKind ||
        current.targetArn !== options.targetArn ||
        current.dedupKey !== dedupKey
      ) {
        throw new Error("Durable terminal notification is bound to a different run or transport");
      }
      if (current.status !== "armed") {
        throw new Error("A terminal notification receipt cannot be armed from a nonterminal state");
      }
      if (options.coordinator.revision < current.coordinatorRevision) {
        throw new Error("Terminal notification arm cannot regress its coordinator revision");
      }
    }
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const armed = terminalNotificationSchema.parse({
      schemaVersion: "elephant.clermont-terminal-notification.v1",
      runId: options.runId,
      coordinatorRevision: options.coordinator.revision,
      transportKind: options.transportKind,
      targetArn: options.targetArn,
      dedupKey,
      status: "armed",
      attempts: 0,
      createdAt: current?.createdAt ?? observedAt,
      updatedAt: observedAt,
      lastAttemptAt: null,
      nextAttemptAt: null,
      deliveredAt: null,
      receiptId: null,
    });
    await persistClermontTerminalNotification(options.runStore, armed, lock.assertOwned);
  } finally {
    await lock.release();
  }
}

export async function deliverClermontTerminalNotification(options: {
  runStore: string;
  runId: string;
  coordinatorBefore: ClermontCoordinatorSnapshot | null;
  coordinatorAfter: ClermontCoordinatorSnapshot;
  transportKind: ClermontFailureTransport["kind"];
  targetArn: string;
  invokeNotifier: (
    targetArn: string,
    event: ClermontNotifierEvent,
  ) => Promise<ClermontNotificationReceipt>;
  now?: () => Date;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<void> {
  const now = options.now ?? (() => new Date());
  const retryDelaysMs = options.retryDelaysMs ?? [250, 1_000];
  if (
    retryDelaysMs.length > 5 ||
    retryDelaysMs.some((delayMs) => !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000)
  ) {
    throw new Error("Terminal notification permits at most five retry delays of 0ms to 60000ms");
  }
  if (options.transportKind === "pagerduty") assertExactClermontNotifierArn(options.targetArn);
  else assertExactClermontFailureTopicArn(options.targetArn);

  const dedupKey = `clermont-acquisition/${options.runId}/FAILED_EXHAUSTED`;
  const event: ClermontNotifierEvent = {
    summary: `Clermont acquisition ${options.runId} exhausted its retry budget`,
    source: "clermont-ingestion-cli",
    dedupKey,
    customDetails: { runId: options.runId, state: "FAILED_EXHAUSTED" },
  };
  const newlyExhausted =
    options.coordinatorBefore !== null &&
    options.coordinatorBefore.runId === options.runId &&
    options.coordinatorAfter.runId === options.runId &&
    options.coordinatorBefore.state !== "FAILED_EXHAUSTED" &&
    options.coordinatorAfter.state === "FAILED_EXHAUSTED" &&
    options.coordinatorAfter.revision > options.coordinatorBefore.revision;

  const lock = await acquireClermontRunLock(clermontRunDirectory(options.runStore, options.runId));
  try {
    let notification = await loadClermontTerminalNotification(options.runStore, options.runId);
    if (notification === null) {
      if (!newlyExhausted) return;
      const createdAt = now().toISOString();
      notification = terminalNotificationSchema.parse({
        schemaVersion: "elephant.clermont-terminal-notification.v1",
        runId: options.runId,
        coordinatorRevision: options.coordinatorAfter.revision,
        transportKind: options.transportKind,
        targetArn: options.targetArn,
        dedupKey,
        status: "pending",
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        lastAttemptAt: null,
        nextAttemptAt: null,
        deliveredAt: null,
        receiptId: null,
      });
      await persistClermontTerminalNotification(options.runStore, notification, lock.assertOwned);
    }
    if (
      notification.runId !== options.runId ||
      notification.transportKind !== options.transportKind ||
      notification.targetArn !== options.targetArn ||
      notification.dedupKey !== dedupKey
    ) {
      throw new Error("Durable terminal notification is bound to a different run or transport");
    }
    if (notification.status === "armed") {
      if (options.coordinatorAfter.state !== "FAILED_EXHAUSTED") return;
      if (options.coordinatorAfter.revision <= notification.coordinatorRevision) {
        throw new Error("Terminal coordinator did not advance beyond its durable notification arm");
      }
      const pendingAt = now().toISOString();
      notification = terminalNotificationSchema.parse({
        ...notification,
        coordinatorRevision: options.coordinatorAfter.revision,
        status: "pending",
        updatedAt: pendingAt,
      });
      await persistClermontTerminalNotification(options.runStore, notification, lock.assertOwned);
    }
    if (options.coordinatorAfter.revision !== notification.coordinatorRevision) {
      throw new Error("Coordinator revision does not match the durable terminal notification");
    }
    if (options.coordinatorAfter.state !== "FAILED_EXHAUSTED") {
      throw new Error("Terminal notification requires a FAILED_EXHAUSTED coordinator");
    }
    if (notification.status === "delivered") return;

    const sleep = options.sleep ?? wait;
    const initialDelay = Math.max(
      0,
      notification.nextAttemptAt === null
        ? 0
        : Date.parse(notification.nextAttemptAt) - now().getTime(),
    );
    if (initialDelay > 0) await sleep(Math.min(initialDelay, 60_000));

    const attemptsThisPass = retryDelaysMs.length + 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attemptsThisPass; attempt += 1) {
      const attemptedAt = now();
      try {
        const receipt = await options.invokeNotifier(options.targetArn, event);
        if (receipt.status !== "triggered" || receipt.dedupKey !== dedupKey) {
          throw new Error("Terminal notification returned a mismatched delivery receipt");
        }
        const receiptId =
          options.transportKind === "sns-email"
            ? z.string().uuid().parse(receipt.receiptId)
            : receipt.dedupKey;
        notification = terminalNotificationSchema.parse({
          ...notification,
          status: "delivered",
          attempts: notification.attempts + 1,
          updatedAt: attemptedAt.toISOString(),
          lastAttemptAt: attemptedAt.toISOString(),
          nextAttemptAt: null,
          deliveredAt: attemptedAt.toISOString(),
          receiptId,
        });
        await persistClermontTerminalNotification(options.runStore, notification, lock.assertOwned);
        return;
      } catch (error) {
        lastError = error;
        const retryDelay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 0;
        notification = terminalNotificationSchema.parse({
          ...notification,
          attempts: notification.attempts + 1,
          updatedAt: attemptedAt.toISOString(),
          lastAttemptAt: attemptedAt.toISOString(),
          nextAttemptAt: new Date(attemptedAt.getTime() + retryDelay).toISOString(),
        });
        await persistClermontTerminalNotification(options.runStore, notification, lock.assertOwned);
        if (attempt < attemptsThisPass - 1 && retryDelay > 0) await sleep(retryDelay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    await lock.release();
  }
}

export async function runWithFailedExhaustedPaging<T>(options: {
  operation: () => Promise<T>;
  loadCoordinator: () => Promise<ClermontCoordinatorSnapshot>;
  invokeNotifier: (
    notifierArn: string,
    event: ClermontNotifierEvent,
  ) => Promise<ClermontNotificationReceipt>;
  notifierArn: string;
  transportKind: ClermontFailureTransport["kind"];
  runStore: string;
  runId: string;
  reportNotificationFailure?: (message: string) => void;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<T> {
  const coordinatorBefore = await options.loadCoordinator();
  await armClermontTerminalNotification({
    runStore: options.runStore,
    runId: options.runId,
    coordinator: coordinatorBefore,
    transportKind: options.transportKind,
    targetArn: options.notifierArn,
  });
  try {
    return await options.operation();
  } catch (originalError) {
    const report =
      options.reportNotificationFailure ??
      ((message: string): void => {
        process.stderr.write(`${message}\n`);
      });
    try {
      const coordinatorAfter = await options.loadCoordinator();
      await deliverClermontTerminalNotification({
        runStore: options.runStore,
        runId: options.runId,
        coordinatorBefore,
        coordinatorAfter,
        transportKind: options.transportKind,
        targetArn: options.notifierArn,
        invokeNotifier: options.invokeNotifier,
        ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
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
        "--failure-topic-arn",
      ],
      ["--live-fetch", "--prune-loose-after-seal"],
    );
    requireFlags(values, ["--repo-root", "--run-store", "--run-id", "--owner", "--now"]);
    if (booleans.has("--prune-loose-after-seal")) {
      throw new Error(
        "The first production Clermont capture must retain loose evidence; pruning is disabled",
      );
    }
    const runStore = path.resolve(values.get("--run-store")!);
    const runId = values.get("--run-id")!;
    const failureTransport = selectClermontFailureTransport({
      ...(values.has("--failure-notifier-arn")
        ? { notifierArn: values.get("--failure-notifier-arn")! }
        : {}),
      ...(values.has("--failure-topic-arn")
        ? { topicArn: values.get("--failure-topic-arn")! }
        : {}),
    });
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
      loadCoordinator: async () => {
        const coordinator = await loadClermontCoordinator(runStore, runId);
        return {
          runId: coordinator.runId,
          revision: coordinator.revision,
          state: coordinator.state,
        };
      },
      invokeNotifier:
        failureTransport.kind === "pagerduty"
          ? invokeClermontFailureNotifier
          : invokeClermontFailureTopic,
      notifierArn: failureTransport.targetArn,
      transportKind: failureTransport.kind,
      runStore,
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
