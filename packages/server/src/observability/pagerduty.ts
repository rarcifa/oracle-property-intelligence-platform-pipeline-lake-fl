/**
 * Paging on-call when this runtime fails terminally.
 *
 * The engineering guidelines make this non-negotiable: a service that can fail
 * critically but cannot page on-call is an incomplete service, and swallowing a
 * critical failure with a log-only handler is forbidden. This deployment had a
 * log-only handler on exactly that path — a boot that could not open the
 * published dataset returned 503 to the caller and told nobody.
 *
 * Two channels, deliberately, per `observability-pagerduty-alerting` and
 * `observability-dlq-alarms`:
 *
 *  - **Rate signals** (Lambda errors, throttles, a refresh that keeps failing)
 *    are driven from one self-resolving CloudWatch alarm per failure mode,
 *    which fans out to an SNS topic that PagerDuty subscribes to. The alarm
 *    owns the incident lifecycle: `ALARM` triggers, `OK` resolves. That wiring
 *    lives in the CDK stack, not here.
 *  - **A terminal failure of a single critical operation** is triggered
 *    directly, from the point where it becomes terminal. That is this module.
 *
 * What is NOT paged: anything self-healing. A pointer refresh that fails leaves
 * the process serving a verified published run, so it is degraded freshness and
 * belongs to the alarm, not to a page. Over-paging trains responders to ignore
 * alerts.
 *
 * The routing key is read from Secrets Manager at runtime and never logged,
 * never put in an environment variable, and never included in a payload.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** PagerDuty Events API v2. */
export const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

export interface PagerDutyAlert {
  /** One line an on-call responder reads first. */
  summary: string;
  /** The thing that failed, as an identifier. */
  source: string;
  severity: "critical" | "error" | "warning" | "info";
  /**
   * Stable key for this failure class, so a container that retries a failing
   * boot every few seconds keeps updating one incident instead of opening
   * hundreds.
   */
  dedupKey: string;
  customDetails?: Record<string, unknown>;
}

export interface PagerDutyEnvironment {
  /** Secrets Manager id holding the per-service routing key. */
  secretId?: string;
  /**
   * Paging is gated to production so a non-prod run never wakes anybody. The
   * gate is explicit rather than inferred: an unset value does not page.
   */
  environment?: string;
  fetchImpl?: typeof fetch;
  secretsClient?: { send: (command: GetSecretValueCommand) => Promise<{ SecretString?: string }> };
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
}

/** Result of an attempt to page. `skipped` is a decision, not a failure. */
export type PagerDutyResult =
  | { status: "triggered"; dedupKey: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

let cachedRoutingKey: string | null = null;

/** Forget the cached routing key. Tests only. */
export function resetPagerDutyRoutingKey(): void {
  cachedRoutingKey = null;
}

/**
 * Read the routing key from Secrets Manager, once per container.
 *
 * @returns the key, or null when none is configured or it cannot be read.
 */
async function routingKey(env: PagerDutyEnvironment): Promise<string | null> {
  if (cachedRoutingKey !== null) return cachedRoutingKey;
  const secretId = env.secretId;
  if (secretId === undefined || secretId.length === 0) return null;
  const client =
    env.secretsClient ??
    (new SecretsManagerClient({}) as unknown as NonNullable<PagerDutyEnvironment["secretsClient"]>);
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = result.SecretString?.trim();
  if (value === undefined || value.length === 0) return null;
  cachedRoutingKey = value;
  return cachedRoutingKey;
}

/**
 * Page on-call for a terminal failure.
 *
 * Never throws: the caller is already handling a failure and must be free to
 * rethrow the original one. A page that could not be sent is reported back so
 * the caller can log that fact rather than assume somebody was told.
 */
export async function triggerPagerDutyAlert(
  alert: PagerDutyAlert,
  env: PagerDutyEnvironment = {},
): Promise<PagerDutyResult> {
  const environment = env.environment ?? process.env.ORACLE_ALERT_ENVIRONMENT;
  if (environment !== "production") {
    return {
      status: "skipped",
      reason: `not the production environment (${environment ?? "unset"})`,
    };
  }
  try {
    const key = await routingKey({
      ...env,
      secretId: env.secretId ?? process.env.ORACLE_PAGERDUTY_SECRET_ID,
    });
    if (key === null)
      return { status: "skipped", reason: "no PagerDuty routing key is configured" };
    const fetchImpl = env.fetchImpl ?? fetch;
    const response = await fetchImpl(PAGERDUTY_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: key,
        event_action: "trigger",
        dedup_key: alert.dedupKey,
        payload: {
          summary: alert.summary,
          source: alert.source,
          severity: alert.severity,
          component: "oracle-lake-runtime",
          custom_details: alert.customDetails ?? {},
        },
      }),
    });
    // Events API v2 accepts asynchronously: 202 means enqueued, and anything
    // else means on-call was not told.
    if (response.status !== 202) {
      return { status: "failed", reason: `PagerDuty returned HTTP ${response.status}` };
    }
    const body = (await response.json().catch(() => ({}))) as { dedup_key?: unknown };
    return {
      status: "triggered",
      dedupKey: typeof body.dedup_key === "string" ? body.dedup_key : alert.dedupKey,
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
