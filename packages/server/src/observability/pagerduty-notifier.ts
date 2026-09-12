import { Logger } from "@aws-lambda-powertools/logger";
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";

import {
  boundedPagerDutyDetails,
  cloudWatchAlarmDedupKey,
  resetPagerDutyRoutingKey,
  triggerPagerDutyAlert,
  type PagerDutyAlert,
  type PagerDutyEnvironment,
  type PagerDutyResult,
} from "./pagerduty.js";

const directEventSchema = z
  .object({
    summary: z.string().min(1).max(256),
    source: z.string().min(1).max(128),
    dedupKey: z.string().min(1).max(255),
    customDetails: z.record(z.unknown()).optional(),
  })
  .strict();

const batchEventSchema = z.object({
  source: z.string().optional(),
  detail: z.object({
    status: z.literal("FAILED"),
    jobName: z.string().min(1).max(128).optional(),
    jobId: z.string().min(1).max(128).optional(),
    jobQueue: z.string().min(1).max(512).optional(),
    statusReason: z.string().min(1).max(1_024).optional(),
  }),
});

const alarmMessageSchema = z.object({
  AlarmName: z.string().min(1).max(255),
  NewStateValue: z.enum(["ALARM", "OK"]),
  NewStateReason: z.string().min(1).max(1_024),
  StateChangeTime: z.string().datetime(),
  Region: z.string().min(1).max(128),
});

const snsEventSchema = z.object({
  Records: z.array(z.object({ Sns: z.object({ Message: z.string().min(1) }) })).length(1),
});

const logger = new Logger({ serviceName: "oracle-lake-pagerduty-notifier" });
const tracer = new Tracer({ serviceName: "oracle-lake-pagerduty-notifier" });
const metrics = new Metrics({ namespace: "OracleLake", serviceName: "pagerduty-notifier" });

export function boundedDetails(
  details: Record<string, unknown>,
  maximumEntries = 20,
): Record<string, unknown> {
  return boundedPagerDutyDetails(details, maximumEntries);
}

function unwrapSnsMessage(raw: unknown): unknown | null {
  const envelope = snsEventSchema.safeParse(raw);
  if (!envelope.success) return null;
  try {
    return JSON.parse(envelope.data.Records[0]!.Sns.Message) as unknown;
  } catch {
    throw new Error("PagerDuty SNS message is not valid JSON");
  }
}

function parseAlarmMessage(message: unknown): PagerDutyAlert | null {
  const alarm = alarmMessageSchema.safeParse(message);
  if (!alarm.success) {
    if (typeof message === "object" && message !== null && "AlarmName" in message) {
      throw new Error("CloudWatch alarm SNS message failed validation");
    }
    return null;
  }
  const action = alarm.data.NewStateValue === "ALARM" ? "trigger" : "resolve";
  return {
    summary: `${alarm.data.AlarmName} entered ${alarm.data.NewStateValue}`,
    source: "cloudwatch/alarm",
    severity: action === "trigger" ? "critical" : "info",
    eventAction: action,
    dedupKey: cloudWatchAlarmDedupKey(alarm.data.AlarmName),
    component: process.env.ALERT_COMPONENT ?? "oracle-lake-runtime",
    customDetails: boundedDetails({
      alarmName: alarm.data.AlarmName,
      state: alarm.data.NewStateValue,
      reason: alarm.data.NewStateReason,
      changedAt: alarm.data.StateChangeTime,
      region: alarm.data.Region,
    }),
  };
}

function parseDirectOrBatchEvent(raw: unknown): PagerDutyAlert {
  const direct = directEventSchema.safeParse(raw);
  if (direct.success) {
    return {
      ...direct.data,
      severity: "critical",
      eventAction: "trigger",
      component: process.env.ALERT_COMPONENT ?? "county-ingestion",
      customDetails: boundedDetails(direct.data.customDetails ?? {}),
    };
  }
  const batch = batchEventSchema.safeParse(raw);
  if (!batch.success) throw new Error("PagerDuty notification event failed validation");
  const jobIdentity = batch.data.detail.jobId ?? batch.data.detail.jobName ?? "unknown";
  return {
    summary: `AWS Batch job ${batch.data.detail.jobName ?? jobIdentity} failed`,
    source: batch.data.source ?? "aws.batch",
    severity: "critical",
    eventAction: "trigger",
    dedupKey: `aws-batch/${jobIdentity}`,
    component: process.env.ALERT_COMPONENT ?? "county-enrichment-batch",
    customDetails: boundedDetails(batch.data.detail),
  };
}

export function parsePagerDutyNotification(raw: unknown): PagerDutyAlert {
  const message = unwrapSnsMessage(raw) ?? raw;
  return parseAlarmMessage(message) ?? parseDirectOrBatchEvent(message);
}

export async function handlePagerDutyNotification(
  raw: unknown,
  environment: PagerDutyEnvironment = {},
): Promise<Extract<PagerDutyResult, { status: "triggered" | "resolved" }>> {
  const alert = parsePagerDutyNotification(raw);
  const result = await triggerPagerDutyAlert(alert, environment);
  if (result.status !== "triggered" && result.status !== "resolved") {
    throw new Error(`PagerDuty notification failed: ${result.reason}`);
  }
  return result;
}

export function resetPagerDutyNotificationState(): void {
  resetPagerDutyRoutingKey();
}

export async function handler(event: unknown): Promise<PagerDutyResult> {
  const started = Date.now();
  const subsegment = tracer.getSegment()?.addNewSubsegment("PagerDutyEventsApi");
  try {
    const result = await handlePagerDutyNotification(event, {
      environment: process.env.ALERT_ENVIRONMENT,
      accountId: process.env.ALERT_ACCOUNT_ID,
      region: process.env.ALERT_REGION ?? process.env.AWS_REGION,
      secretArn: process.env.PAGERDUTY_SECRET_ARN,
    });
    metrics.addMetric("NotificationProcessed", MetricUnit.Count, 1);
    logger.info("pagerduty_notification_processed", {
      status: result.status,
      dedupKey: result.dedupKey,
    });
    subsegment?.addAnnotation("status", result.status);
    return result;
  } catch (error) {
    metrics.addMetric("NotificationFailed", MetricUnit.Count, 1);
    tracer.addErrorAsMetadata(error as Error);
    subsegment?.addError(error as Error);
    logger.error("pagerduty_notification_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: String(error).slice(0, 512),
    });
    throw error;
  } finally {
    metrics.addMetric("ProcessingDuration", MetricUnit.Milliseconds, Date.now() - started);
    metrics.publishStoredMetrics();
    subsegment?.close();
  }
}
