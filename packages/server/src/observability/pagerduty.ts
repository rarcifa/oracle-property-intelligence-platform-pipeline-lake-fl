import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

export const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
export const PAGERDUTY_PRODUCTION_ACCOUNT = "122610508924";
export const PAGERDUTY_PRODUCTION_REGION = "us-east-2";
export const DATASET_UNAVAILABLE_ALARM_NAME = "OracleLake-dataset-unavailable";

export function cloudWatchAlarmDedupKey(alarmName: string): string {
  return `cloudwatch-alarm/${alarmName}`;
}

const PAGERDUTY_SECRET_ARN_PATTERN = new RegExp(
  `^arn:aws:secretsmanager:${PAGERDUTY_PRODUCTION_REGION}:${PAGERDUTY_PRODUCTION_ACCOUNT}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`,
);
const pagerDutyReceiptSchema = z.object({
  dedup_key: z.string().min(1).max(255),
});
const SENSITIVE_DETAIL_KEY = /authorization|credential|password|routing|secret|token/i;

export interface PagerDutyAlert {
  summary: string;
  source: string;
  severity: "critical" | "error" | "warning" | "info";
  dedupKey: string;
  eventAction?: "trigger" | "resolve";
  component?: string;
  customDetails?: Record<string, unknown>;
}

export interface PagerDutyEnvironment {
  secretArn?: string;
  environment?: string;
  accountId?: string;
  region?: string;
  fetchImpl?: typeof fetch;
  secretsClient?: { send: (command: GetSecretValueCommand) => Promise<{ SecretString?: string }> };
}

export type PagerDutyResult =
  | { status: "triggered"; dedupKey: string }
  | { status: "resolved"; dedupKey: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

let cachedRoutingKey: string | null = null;

export function resetPagerDutyRoutingKey(): void {
  cachedRoutingKey = null;
}

export function isExactPagerDutySecretArn(value: string): boolean {
  return PAGERDUTY_SECRET_ARN_PATTERN.test(value);
}

function boundedPagerDutyValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.slice(0, 512);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 3) return String(value).slice(0, 512);
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => boundedPagerDutyValue(entry, depth + 1));
  }
  if (typeof value !== "object" || value === null) return String(value).slice(0, 512);
  return boundedPagerDutyDetails(value as Record<string, unknown>, 10, depth + 1);
}

export function boundedPagerDutyDetails(
  details: Record<string, unknown>,
  maximumEntries = 20,
  depth = 0,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !SENSITIVE_DETAIL_KEY.test(key))
      .slice(0, maximumEntries)
      .map(([key, value]) => [key.slice(0, 128), boundedPagerDutyValue(value, depth)]),
  );
}

function parseRoutingKey(secretString: string): string {
  const trimmed = secretString.trim();
  if (trimmed.length === 0) throw new Error("PagerDuty routing-key secret is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("routing_key" in parsed) ||
    typeof parsed.routing_key !== "string" ||
    parsed.routing_key.trim().length === 0
  ) {
    throw new Error("PagerDuty JSON secret must contain a non-empty routing_key");
  }
  return parsed.routing_key.trim();
}

async function routingKey(env: PagerDutyEnvironment): Promise<string> {
  if (cachedRoutingKey !== null) return cachedRoutingKey;
  const secretArn = env.secretArn;
  if (secretArn === undefined || !isExactPagerDutySecretArn(secretArn)) {
    throw new Error("PagerDuty requires one exact production Secrets Manager ARN");
  }
  const client =
    env.secretsClient ??
    (new SecretsManagerClient({}) as unknown as NonNullable<PagerDutyEnvironment["secretsClient"]>);
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (typeof result.SecretString !== "string") {
    throw new Error("PagerDuty routing-key secret has no SecretString");
  }
  cachedRoutingKey = parseRoutingKey(result.SecretString);
  return cachedRoutingKey;
}

async function parseAcceptedReceipt(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("PagerDuty 202 response is not valid JSON and has no dedup_key");
  }
  const parsed = pagerDutyReceiptSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("PagerDuty 202 response has no valid dedup_key");
  }
  return parsed.data.dedup_key;
}

export async function triggerPagerDutyAlert(
  alert: PagerDutyAlert,
  env: PagerDutyEnvironment = {},
): Promise<PagerDutyResult> {
  const environment = env.environment ?? process.env.ORACLE_ALERT_ENVIRONMENT;
  const accountId = env.accountId ?? process.env.ORACLE_ALERT_ACCOUNT_ID;
  const region = env.region ?? process.env.AWS_REGION;
  if (
    environment !== "production" ||
    accountId !== PAGERDUTY_PRODUCTION_ACCOUNT ||
    region !== PAGERDUTY_PRODUCTION_REGION
  ) {
    return {
      status: "skipped",
      reason: `not the exact production target (${environment ?? "unset"}/${accountId ?? "unset"}/${region ?? "unset"})`,
    };
  }

  try {
    const key = await routingKey({
      ...env,
      secretArn: env.secretArn ?? process.env.ORACLE_PAGERDUTY_SECRET_ARN,
    });
    const action = alert.eventAction ?? "trigger";
    const response = await (env.fetchImpl ?? fetch)(PAGERDUTY_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: key,
        event_action: action,
        dedup_key: alert.dedupKey.slice(0, 255),
        payload: {
          summary: alert.summary.slice(0, 256),
          source: alert.source.slice(0, 128),
          severity: alert.severity,
          component: (alert.component ?? "oracle-lake-runtime").slice(0, 128),
          custom_details: boundedPagerDutyDetails(alert.customDetails ?? {}),
        },
      }),
    });
    if (response.status !== 202) {
      return { status: "failed", reason: `PagerDuty returned HTTP ${response.status}` };
    }
    const returnedDedupKey = await parseAcceptedReceipt(response);
    return {
      status: action === "resolve" ? "resolved" : "triggered",
      dedupKey: returnedDedupKey,
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
